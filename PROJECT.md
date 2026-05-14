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

- **`/sentinel/src/lib/postgres-sync/`** — the changes-feed mirror worker.
  Runs inside the sentinel process, independently of sentinel's existing
  transition / scheduled-task loops.
- **`/api/`** — the existing API server hosts the new `pg-sync` endpoint
  alongside its current routes.
- **`/webapp/`** — the offline client is patched here, behind a feature
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

### Subject derivation

`subject` is computed at mirror time from the CouchDB document.
The canonical rule already exists in the CouchDB view at
`ddocs/medic-db/medic/nouveau/docs_by_replication_key/index.js` — that
file is the source of truth; the mirror's `transform.js` ports the
equivalent logic. In summary:

- **Contact-type docs** (`person`, `clinic`, `health_center`,
  `district_hospital`, `contact`): `subject = doc._id`. The contact is
  authorized for itself and for any ancestor of itself.
- **`data_record` (reports)**: `subject` is the patient/place the
  report is about, resolved in this priority order:
  `doc.patient_id` → `doc.fields.patient_id` → `doc.place_id` →
  `doc.fields.place_id` → `doc.fields.patient_uuid` → `doc.contact._id`.
  If none resolves, `subject = '_unassigned'`.
- **`task`, `target` docs**: `subject = doc.owner` (or equivalent
  owning-contact field — see the view for the exact rules).
- **System docs** (`resources`, `branding`, `settings`, `form`,
  `translations`, etc.): treat as global; the mirror may store them
  with `subject = NULL` and the sync endpoint may return them
  unconditionally. Out of scope for a first cut if not needed.

If the view's logic and this summary disagree, the **view wins** —
update PROJECT.md and proceed.

### Existing implementations to model on

- **`api/src/services/replication/authorization.js`** — the current
  CouchDB-backed authorization logic. The pg-sync handler should
  produce semantically equivalent results (modulo the PoC scope cuts).
  Read it for the user→subjects resolution and the descendant rules.
- **`ddocs/medic-db/medic/nouveau/docs_by_replication_key/index.js`** —
  canonical `subject` derivation (see above).
- **`~/medic/cht-sync/couch2pg`** — the structural model for the
  mirror worker (change-feed tail, seq persistence, restart/resume).
  Note: this path is outside the openchis repo. If a headless agent's
  sandbox blocks reads there, stop and ask the user to either symlink
  it into the worktree or add the path to the agent's allowed reads.
  Do not proceed by guessing at the reference design.

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
`tasks`. These are reserved for later PoC work and may not be exercised
by every assignment.

**Schema coordination:** all code working against Postgres should code
against the shape in this file. If an assignment needs a schema change,
edit `postgres-sync-setup.sql` and leave a header comment noting the
change and the date so a parallel agent doesn't silently diverge.

## Sync Endpoint Contract

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

## Working Agreement (for agents)

Per-task assignment files live in `.agents/assignments/<id>.md`. Each
describes a single piece of work — branch, base, worktree path, done-when
test command, and a prose brief. Scripts in `scripts/agents/` create
worktrees and launch headless agents against them. PROJECT.md is the
durable project-level context that every assignment refers back to.

- **One branch per assignment.** Agents work on the branch named in
  their assignment and never on the base branch directly.
- **No remote pushes.** Agents must not `git push`. The user merges
  locally when satisfied.
- **Commit when unit tests pass.** An agent makes its task commit once
  the assignment's unit tests are green. Intermediate checkpoint
  commits are allowed for recovery; the final state should read as a
  clean single-task commit.
- **Unit tests are the contract.** A task is not done until its unit
  tests pass.
- **No running services for unit-test work.** Agents work entirely
  against mocks:
  - **Mock the Postgres client.** Use a fake/stub for `pg`. Do not
    connect to a real database, even a local one.
  - **Mock CouchDB.** Mirror-worker tests feed synthetic change-feed
    payloads. Client tests mock `fetch`/HTTP and use an in-memory
    PouchDB.
  - Connection details (`COUCH_URL`, `POSTGRES_URL`) are read from env
    vars **only by production code paths**. Assignment work may
    reference these names but must not depend on the services being up.
  If an agent finds itself needing a live service to write a unit test,
  that's a signal the test is the wrong shape — restructure with a mock.
- **Schema changes are coordinated.** Multiple assignments may touch
  Postgres. Edit `postgres-sync-setup.sql` directly when needed and
  leave a header comment noting the change and the date so a parallel
  agent doesn't silently diverge.

### Resuming after interruption

Agents may be killed, hit context limits, or otherwise restart with no
in-memory state. On-disk artefacts are the only durable record of
progress. Every fresh-or-resumed agent invocation must run this protocol
**before doing any new work**:

1. `cd` into the worktree (path is in the assignment frontmatter).
2. `cat TASK_STATE.md` if it exists — the prior agent's notes on what
   was done, what's next, and any open questions or blockers.
3. `git log --oneline -20` — checkpoint commits show the resume point.
4. Run the assignment's `done_when` command. The set of passing vs.
   missing vs. failing tests is the canonical "where am I" signal.
5. Decide the next step from those three inputs. Update
   `TASK_STATE.md` with what's now in progress before making changes.

Conventions:

- **`TASK_STATE.md`** is a per-worktree scratchpad. It is in
  `.gitignore` and must not be committed. Keep it short: current step,
  next step, blockers, open questions. Append as work proceeds; do not
  rewrite history in it.
- **Checkpoint commits** are encouraged at every coherent step. They
  exist to make resume cheap; they do not need polished messages.
- Tests are the contract. If unit tests pass, the task is done
  regardless of what `TASK_STATE.md` says.
