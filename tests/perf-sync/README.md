# perf-sync — live-stack pg-sync harness

Sync-performance harness against a live API + CouchDB + Postgres stack.
Drives N virtual CHW clients against the same code paths the webapp uses
in production:

- **Push** via `PouchDB.replicate.to(remote, { filter: readOnlyFilter })`
  — same call, same filter, same checkpoint shape as `DBSyncService`.
- **Pull** (pg-sync) — ported verbatim from `PgReplicationService`:
  `POST /api/v1/pg-sync { since }` → `bulkDocs(docs, { new_edits: false })`,
  cursor at `_local/medic-pg-sync-state`.
- **Pull** (nairobi) — ported verbatim from `ReplicationService`:
  `get-ids` → diff against local `allDocs` → batched `_bulk_get` +
  `bulkDocs(new_edits: false)` for missing docs → batched
  `/api/v1/replication/get-deletes` + `bulkDocs` tombstones for purges.

Each sync runs **push then pull** — the same order as webapp's
`syncMedic` (`to:` first, then `from:`).

## What this harness does

1. **Remote seed** (`lib/setup.js`) — invokes test-data-generator with the
   `perf-one-user` wrapper (loops `one-user.js` `--users=N` times, stamping
   each CHW's username) to populate CouchDB with N CHW subtrees plus
   `_users` / `user-settings` / telemetry / 100 tasks per CHW and one
   pregnancy danger sign report. The CHW username is stamped to
   `perf-chw-<runId>-<i>` so the harness can sign in by index.
2. **Local seed** (`lib/local-seed.js`, optional) — if
   `--pending-uploads=<n>` is set, dynamic-imports test-data-generator's
   `built/doc-writer.js`, monkeypatches `.write` / `.flush` to capture
   instead of POST, runs `Docs.createDocs` against the
   `perf-pending-uploads` design, and `bulkDocs` the captured docs into
   the user's in-memory PouchDB. This is the "work the CHW did offline
   before syncing" simulation.
3. **Sync** (`lib/client.js`) — for each scheduled sync:
   - `push.push({ local, remote })` — measures docs_pushed and push_ms.
   - `nairobi.sync` or `pgSync.sync` — measures docs_pulled and pull_ms.
4. **Output** (`lib/runner.js` + `lib/metrics.js`) — one CSV row per
   `(user, sync)` to `results/<scenario>-<protocol>-<ts>.csv` and a
   stdout summary with p50 / p95 / max per direction.

## Prerequisites

- A reachable API on `http://localhost:5988` (`config.json` is the
  override knob).
- CouchDB on `:5984` and Postgres on `:5432`, with the `medic_documents`
  / `contacts` schema and the medic ddocs already in place.
- Admin credentials in `config.json`. They get folded into a `COUCH_URL`
  env var that test-data-generator's writer reads.
- **`POSTGRES_URL` set in the API's environment.** The pg-sync controller
  reads this when handling `/api/v1/pg-sync`; without it every pull 500s
  with `SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a
  string`. For the dev API, export
  `POSTGRES_URL=postgres://postgres:postgres@localhost:5432/postgres`
  before `npm run dev-api`.
- `test-data-generator` checked out and built next to this repo. The
  harness probes both the merged-into-openchis layout
  (`../../../../test-data-generator`) and the worktree layout
  (`../../../../../../test-data-generator`); override with
  `PERF_SYNC_TDG_PATH`.

## Running it

Start the API in a separate terminal (logs are diagnostic; the HTTP
socket is authoritative). The harness does **not** start the stack.

```bash
# Baseline (single sync per user; pull-only by default).
node tests/perf-sync/cli.js baseline --users=1 --protocol=pg-sync --run-id=smoke

# Baseline with pending uploads (the CHW has 5 docs to push).
node tests/perf-sync/cli.js baseline --users=1 --protocol=pg-sync \
  --pending-uploads=5 --run-id=push-smoke

# Initial + ongoing sync (proves the cursor round-trip + delta cost).
node tests/perf-sync/cli.js initial-vs-ongoing --users=1 --protocol=pg-sync \
  --pending-uploads=5 --run-id=cursor

# Run both protocols against the same CHW and report the doc-id set diff.
node tests/perf-sync/cli.js compare-protocols --users=1 --run-id=cmp
```

Expected stdout for `baseline --pending-uploads=5`:

```
baseline: CSV written to .../tests/perf-sync/results/baseline-pg-sync-<ts>.csv
scenario=baseline protocol=pg-sync users=1 docs_pulled=167 docs_pushed=5 errors=0 \
  elapsed_ms=[p50=<n> p95=<n> max=<n>] \
  push_ms=[p50=<n> p95=<n> max=<n>] \
  pull_ms=[p50=<n> p95=<n> max=<n>]
```

`docs_pulled` per user lands in the 60–170 range — health_center + 10
households + ~40 persons + ~10 reports + 100 tasks + the CHW's own
contact + `user-settings`. `docs_pushed` should equal `--pending-uploads`.

`compare-protocols` runs nairobi then pg-sync sequentially against the
same CHW and reports the doc-id set diff. Two asymmetries are expected:

- **pg-sync has +100 tasks per CHW.** `docs_by_replication_key` keys
  tasks by `doc.user`; test-data-generator emits `owner` but no `user`,
  so the view returns zero tasks. pg-sync's `transform.getSubject` falls
  back to `doc.owner` per PROJECT.md.
- **nairobi has +~37 system docs.** The view emits `_design/medic-client`,
  `branding`, `settings`, contact-form ddocs, translations, etc. with
  `key=_all`. pg-sync's transform does not currently mirror that "global
  doc" pathway.

## CSV output

Columns in `tests/perf-sync/results/<scenario>-<protocol>-<ts>.csv`:

| column | meaning |
|---|---|
| `scenario` | scenario name |
| `protocol` | `pg-sync` or `nairobi` |
| `user_id` | username of the virtual user |
| `sync_index` | 0-based sync within the user's scenario flow |
| `kind` | `initial` for the first sync, `ongoing` for subsequent syncs |
| `docs_pulled` | docs the client received from the server this sync |
| `docs_pushed` | docs the client pushed to the server this sync |
| `elapsed_ms` | wall-clock around the entire push+pull pair |
| `push_ms` | wall-clock around `replicate.to` alone |
| `pull_ms` | wall-clock around the protocol's pull alone |
| `error` | empty on success; `push: …` / `pull: …` on failure |

A push failure does **not** suppress the pull number (and vice versa) —
matches webapp's `syncMedic` which records both outcomes independently.

## Where the webapp code is mirrored

The harness ports algorithms line-by-line rather than instantiating
Angular services in Node. Sources of truth:

- `webapp/src/ts/services/pg-replication.service.ts` →
  `tests/perf-sync/lib/protocols/pg-sync.js`
- `webapp/src/ts/services/replication.service.ts` →
  `tests/perf-sync/lib/protocols/nairobi.js`
- `webapp/src/ts/services/db-sync.service.ts` (replicateTo +
  readOnlyFilter) → `tests/perf-sync/lib/protocols/push.js`

If you change one of the webapp services, mirror the change in the
corresponding harness module.

## After editing `api/src/` or `shared-libs/**/src/`

nodemon (driven by `npm run dev-api`) watches both trees and restarts
the API automatically. After an edit:

```bash
sleep 3                                                              # let nodemon notice
curl -sf -o /dev/null http://medic:password@localhost:5988/medic/    # exit 0 = ready
```

A wrapper for the polling loop lives at
`tests/perf-sync/scripts/wait-for-api.sh`.

## Run-id collisions

`--run-id` namespaces every doc that depends on the CHW's username,
but the CouchDB `org.couchdb.user:perf-chw-<runId>-<i>` doc itself
has a fixed `_id` per (runId, i). `setup.js` deletes any stale
copies before generating, so a repeat `--run-id=smoke` lands cleanly
without the user-settings pointing at a previous run's hierarchy.

test-data-generator generates fresh UUIDs for every other contact,
so leftover docs from prior runs are inert. **Do not** truncate
Postgres or drop the `medic` database to "clean up"; the Postgres
schema is shared with the API and other tooling.

## Tests

The harness is validated end-to-end by running the CLI against a live
stack — that is the contract. Library-level unit tests inherited from
the mocks-only Phase 1 harness were dropped as part of the live-stack
rewrite; the parts the smoke test exercises that have unit coverage
elsewhere are the `pg-sync` shared-lib transform/write code:

```bash
npx --prefix shared-libs/postgres-sync mocha 'test/**/*.spec.js'
```
