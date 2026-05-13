# Project: Partial Postgres Replacement for CouchDB Sync (PoC)

## Goal

Build a proof of concept that replaces part of CouchDB with Postgres to provide
a simpler and more performant sync implementation for offline clients. This is
**not** intended for production deployment — the PoC must demonstrate that
single-database CouchDB is the root cause of current sync pain, that Postgres
avoids those problems, and that the migration can be decomposed into small,
incrementally shippable changes.

## Background

CHT uses a single CouchDB database shared by all users. Because of this,
out-of-the-box PouchDB ↔ CouchDB replication cannot be used for download: each
client only gets a user-specific subset of documents. Sync today uses the
"Nairobi protocol", a set of workarounds layered over a usage pattern CouchDB
was not designed for.

**Uploads** from offline clients don't cause problems currently.
Clients write to a local PouchDB, then replicate up to CouchDB normally.
This path does not need to change in a first draft.

**Downloads** are the problem. The `get-ids` endpoint that drives client sync
has three structural issues:

1. **No incremental filter.** Every call returns the id of every document the
   user is authorized to see; there is no "changed since last sync" query.
2. **Authorization emulates a join.** Users are attached to a contact in a
   hierarchy and have access to documents linked to any descendant of that
   contact. `get-ids` must first fetch all descendant contact IDs, then run a
   large second query (via Lucene) against another view to find documents
   linked to that list. CouchDB has no real join, so this is expensive.
3. **Purge is a set-intersection bomb.** Admins can configure a purge function
   that runs in a background task to mark documents that should not sync.
   Because CouchDB cannot bulk-modify documents without invalidating indexes
   and polluting the changes feed, purged-document IDs live in *separate*
   per-user databases. Every `get-ids` request intersects the user's accessible
   IDs (tens to hundreds of thousands) against the purge DB (tens of millions).
   Results are cached on success, but the uncached cost can cripple production
   servers.

## Architecture

```
client write → PouchDB (local) → replication → CouchDB
                                                  │
                                       changes feed │
                                                  ▼
                                              Postgres
                                                  │
                                                  ▼
                                       sync read ← client
```

- Writes continue to flow into CouchDB via existing PouchDB replication.
- A changes-feed listener (similar in spirit to `couch2pg`) mirrors documents
  into Postgres.
- Offline clients **read** their sync stream from Postgres instead of from the
  `get-ids` / Nairobi-protocol path.

### Code Locations

- **`/couch2pg/`** — new top-level directory. Houses the changes-feed mirror
  worker (Task 1). Standalone Node service; not part of api/sentinel.
- **`/api/`** — the existing API server hosts the new `pg-sync` endpoint
  (Task 2) alongside its current routes.
- **`/webapp/`** — Task 3 patches the offline client here, behind a feature
  flag, to read from `pg-sync` instead of `get-ids`.

## PoC Constraints

- **Minimal code.** Introduce only the changes needed to demonstrate the
  performance and maintainability wins. No incidental refactors.
- **Incrementally shippable.** The work must decompose into tasks that could
  be released independently in a real migration.
- **Read-side only.** Uploads stay on the CouchDB path.
- **Scope cuts for the auth model** (revisit post-PoC):
  - Ignore `needs_signoff`.
  - Ignore hierarchy depth — treat one level as the only relevant level.
  - Assume a single role.
  - Soft delete must work (`medic_documents.deleted BOOLEAN`).
  - Hierarchy moves (a contact's `parent` changing) **are** in scope; the
    mirror worker is responsible for cascading `lineage` updates to
    descendants.

Authorization in the PoC is expressed via `medic_documents.subject` (the
contact ID that authorizes the document) plus `contacts.lineage TEXT[]`
(the ancestor chain of each contact). A user is authorized for a document
when the user's contact ID is the doc's `subject`, or appears in the
`lineage` of the contact named by `subject`.

## Schema

`postgres-sync-setup.sql` is the schema source of truth for the PoC.
Key tables:

- **`medic_documents`** — all mirrored CouchDB documents. Includes
  `seq BIGSERIAL` (postgres-native change cursor), `subject VARCHAR(255)`,
  `deleted BOOLEAN`, and the full `doc JSONB`.
- **`contacts`** — flattened contact hierarchy with `lineage TEXT[]`.
- **`client_sync_state`** — records the PouchDB seq at which a client
  cut over from the Nairobi protocol to Postgres sync, plus the Postgres
  seq at that moment. Used so clients can resume cleanly.

The file also defines `attachments`, `users`, `sessions`, `reports`, and
`tasks`. These are reserved for later PoC work and are not required by
Tasks 1–3.

**Schema ownership:** Task 2 owns `postgres-sync-setup.sql`. Task 1 must
conform to whatever Task 2 specifies. Schema changes after baseline must
be coordinated through Task 2 (see Working Agreement below).

## Sync Endpoint Contract (Task 2)

- **URL:** `/api/v1/pg-sync` (new; `get-ids` is unchanged).
- **Auth:** existing API session auth. The endpoint resolves the calling
  user's contact ID server-side.
- **Request:** `{ "since": <bigint seq, 0 for initial sync> }`
- **Response:** `{ "docs": [<full doc JSON>...], "last_seq": <bigint> }`
- **Selection rule:** return docs where
  - the user is authorized (per the rule above), **and**
  - `medic_documents.seq > since`, **and**
  - the client needs to know about the doc — including soft-deleted docs
    (so the client can drop them locally). Tombstones are returned with
    `_deleted: true` in the doc body.

## Tasks

Tasks 1 and 2 run in parallel. Task 3 starts once Tasks 1 and 2 are done.
Task 4 (integration) runs last.

### Task 1 — couch2pg mirror worker

**Branch:** `poc/task-1-couch2pg`

A standalone Node service in `/couch2pg/` that:
- Tails the CouchDB `_changes` feed continuously, persisting its position.
- Writes each change into `medic_documents`, populating `subject`, `type`,
  and `deleted` per the schema. Maintains the `contacts` table for
  contact-type documents, including `lineage[]`.
- On a contact's `parent` change, cascades the `lineage` update to all
  descendants in `contacts`, and re-derives `subject` on dependent
  `medic_documents` rows as needed.

**Done when (unit tests are the contract):**
- Unit tests cover: new doc insert, doc update (new `_rev`), soft delete,
  resume from persisted position after restart, hierarchy move cascade,
  malformed change handling.
- `npm test` in `/couch2pg/` passes from a clean checkout.

### Task 2 — pg-sync endpoint and schema

**Branch:** `poc/task-2-pg-sync`

- Owns `postgres-sync-setup.sql`. Evolves the schema as needed; coordinates
  any breaking change with Task 1 by leaving a header comment in the SQL
  file noting the change and the date.
- Adds the `/api/v1/pg-sync` route inside `/api/` following the contract
  above.

**Done when (unit tests are the contract):**
- Unit tests cover: authorization (in-lineage and out-of-lineage docs),
  incremental selection by `since`, tombstone delivery, `last_seq`
  monotonicity, unauthenticated request rejection.
- Existing `npm run unit-api` continues to pass.

### Task 3 — client switch (feature-flagged)

**Branch:** `poc/task-3-client`

Depends on Tasks 1 and 2 being done.

In `/webapp/`, replace the `get-ids`-driven download path with a Postgres
sync path, behind a feature flag. The agent must actually wire the new
code through to PouchDB — not just call the endpoint.

**Scope:**

- Add a feature flag. Default **off**. Both code paths coexist. The flag
  is read from app settings (or a build-time env var — Task 3 picks one
  and documents it).
- When the flag is on, replace the legacy download flow with:
  1. Read the locally-persisted `last_seq` (0 on first run).
  2. `POST /api/v1/pg-sync` with `{ since: last_seq }`.
  3. Apply the response to the local PouchDB:
     - For each doc with `_deleted: true`, remove it locally (via
       `pouch.remove` or equivalent).
     - For each non-deleted doc, upsert into local PouchDB (`bulkDocs`
       with `new_edits: false` so server `_rev`s win, or equivalent
       conflict-aware path — Task 3 picks and documents the strategy).
  4. Persist the response `last_seq` locally so the next call resumes.
  5. Loop or schedule the next call per the existing sync cadence.
- **`last_seq` storage.** Persist `last_seq` in a place that survives
  app restarts and is per-device. Task 3 picks one of: a dedicated
  local-only doc in the user's PouchDB, the meta-db, or browser
  localStorage. Document the choice in code.
- **Cutover.** On a user's first run with the flag on, write the
  `client_sync_state` row server-side (PouchDB seq + Postgres
  `last_seq`) so the new path resumes cleanly from where the Nairobi
  protocol left off. After cutover, the legacy path is no longer
  consulted for that user while the flag remains on.

**Done when (unit tests are the contract):**

Unit tests must cover, against an in-memory PouchDB (or the project's
existing PouchDB test harness):

- Flag off: legacy `get-ids` path runs unchanged; no call to
  `/api/v1/pg-sync`.
- Flag on, initial sync: `since` is 0, fetched docs land in local
  PouchDB and are readable via `pouch.get(id)` with the expected
  contents.
- Flag on, incremental sync: `since` equals the previously persisted
  `last_seq`; only newer docs are written; older docs are not
  re-fetched or re-written.
- Flag on, tombstones: a doc returned with `_deleted: true` is removed
  from local PouchDB; a subsequent `pouch.get(id)` rejects with
  not-found.
- `last_seq` persistence: after a successful sync, the persisted value
  equals the response `last_seq`; after a simulated app restart, the
  next sync uses that value as `since`.
- Cutover: on first flagged sync for a user, the client writes the
  `client_sync_state` row; on subsequent flagged syncs, it does not
  re-write it.
- Network/HTTP failure mid-sync leaves `last_seq` unchanged (the next
  attempt retries from the same point; no partial advance).

Existing `npm run unit-webapp` continues to pass.

### Task 4 — integration

**Branch:** `poc/task-4-integration`

Runs after Tasks 1–3 are merged locally.

- Exercises the full stack (CouchDB + Postgres + couch2pg + api + webapp)
  end-to-end: initial sync, incremental sync, soft delete propagation,
  hierarchy move.
- Adds whatever integration tests are needed under `tests/integration/`
  to cover the above.

**Done when:**
- Integration tests pass against running services.

## Working Agreement (for agents)

- **One branch per task.** Task agents work on the branch listed above
  and never on `master`.
- **No remote pushes.** Agents must not `git push`. The user merges
  locally when satisfied.
- **Commit per task done.** Each agent makes one commit when the task's
  unit tests all pass. Intermediate checkpoint commits are allowed for
  recovery, but the final state should read as a clean single-task commit.
- **Unit tests are the contract.** A task is not done until its unit
  tests pass. Integration verification is deferred to Task 4.
- **Dev services are assumed running.** Agents do not start CouchDB or
  Postgres. They read connection details from env vars:
  - `COUCH_URL` — e.g. `http://admin:pass@localhost:5984`
  - `POSTGRES_URL` — e.g. `postgres://user:pass@localhost:5432/medic`
  If a service is unreachable, fail loudly with a clear message.
- **Schema changes flow through Task 2.** Task 1 and Task 3 must not
  edit `postgres-sync-setup.sql`. If they need a change, they leave a
  TODO in their own code and call it out in their commit message; Task 2
  incorporates the change.
