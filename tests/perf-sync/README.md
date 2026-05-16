# perf-sync — live-stack pg-sync harness

Pg-sync sync-performance harness against a live API + CouchDB + Postgres
stack. The Phase A bar (`baseline --users=1`) is the contract, and the
multi-user fan-out, `initial-vs-ongoing` scenario, and cursor round-trip
are all exercised. The Nairobi driver and percentile metrics are still
deferred (see `AGENT_ASSIGNMENT.md`).

## What this harness does

1. **Setup** (`lib/setup.js`) loads `test-data-generator` and the
   `designs/perf-one-user.js` wrapper, stamps a deterministic CHW
   username (`perf-chw-<runId>-<i>`), and POSTs ~165 docs per user to
   `http://localhost:5988/medic/_bulk_docs`. The API's write-through
   middleware mirrors those docs into Postgres before returning the
   response. Stale `org.couchdb.user:perf-chw-<runId>-<i>` records
   are deleted up-front so the regenerated user-settings docs point at
   the fresh hierarchy.
2. **Client** (`lib/client.js` + `lib/protocols/pg-sync.js`) builds an
   in-memory PouchDB, logs in as the CHW with Basic Auth, and POSTs to
   `/api/v1/pg-sync { since: 0 }`. The response body's `docs` array is
   partitioned into upserts and tombstones, then applied with
   `bulkDocs(new_edits: false)`. The next `since` is persisted to a
   `_local/perf-pg-sync-state` doc on the local PouchDB.
3. **Output** (`lib/runner.js` + `lib/metrics.js`) writes one CSV row
   per `(user, sync)` to `results/baseline-pg-sync-<ts>.csv` and a
   stdout summary line.

## Prerequisites

- A reachable API on `http://localhost:5988` (`config.json` is the
  override knob).
- CouchDB on `:5984` and Postgres on `:5432`, with the `medic_documents`
  / `contacts` schema and the medic ddocs already in place.
- Admin credentials in `config.json`. They get folded into a `COUCH_URL`
  env var that test-data-generator's writer reads.
- `test-data-generator` checked out and built. The harness probes both
  the merged-into-openchis layout (`../../../../test-data-generator`)
  and the worktree layout (`../../../../../../test-data-generator`).
  Override with `PERF_SYNC_TDG_PATH`.

## Running it

The API + infrastructure is **not** started by this harness. Before
invoking the CLI, start the API in a separate terminal:

```bash
cd .agents/perf-harness-live
npm run dev-api 2>&1 | tee tests/perf-sync/logs/perf-api.log
```

Then, from the worktree root:

```bash
# Baseline (initial sync only). Supported --protocol values: pg-sync, nairobi.
node tests/perf-sync/cli.js baseline --users=1 --protocol=pg-sync --run-id=smoke

# Initial + ongoing sync; verifies the _local cursor round-trip:
node tests/perf-sync/cli.js initial-vs-ongoing --users=1 --protocol=pg-sync --run-id=cursor

# Run both protocols against the same CHW and report the doc-id set diff:
node tests/perf-sync/cli.js compare-protocols --users=1 --run-id=cmp
```

Expected stdout for `baseline`:

```
baseline: CSV written to .../tests/perf-sync/results/baseline-pg-sync-<ts>.csv
scenario=baseline protocol=pg-sync users=<n> docs_pulled=<~162*n> errors=0 \
  elapsed_ms=[p50=<n> p95=<n> max=<n>]
```

`docs_pulled` per user should land in the 60–170 range — roughly 1
health_center + 10 households + 40 persons + 10 reports + 100 tasks +
the CHW's own contact, plus the CHW's `user-settings`. `max=` is a
rough wall-clock proxy for the concurrent fan-out.

Expected stdout for `initial-vs-ongoing`:

```
initial-vs-ongoing: CSV written to .../tests/perf-sync/results/initial-vs-ongoing-pg-sync-<ts>.csv
scenario=initial-vs-ongoing protocol=pg-sync users=<n> initial_docs=<~162*n> ongoing_docs=0 errors=0 \
  initial_ms=[p50=<n> p95=<n> max=<n>] ongoing_ms=[p50=<n> p95=<n> max=<n>]
```

`ongoing_docs=0` is the proof that the second sync honoured the cursor —
with no new writes between sync #1 and sync #2, asking for
`since=last_seq_from_sync_1` must yield zero new docs. The `ongoing_ms`
percentiles being an order of magnitude smaller than `initial_ms` is
the signal that the round-trip itself collapsed.

`compare-protocols` runs nairobi then pg-sync sequentially against the
same CHW and reports the doc-id set diff. Two asymmetries are expected
today:

- **pg-sync has +100 tasks per CHW.** `docs_by_replication_key` keys
  tasks by `doc.user`; test-data-generator emits `owner` but no `user`,
  so the view returns zero tasks for these CHWs. pg-sync's
  `transform.getSubject` falls back to `doc.owner` per PROJECT.md.
- **nairobi has +~37 system docs.** The view emits `_design/medic-client`,
  `branding`, `settings`, contact-form ddocs, translations, etc. with
  `key=_all` so every user replicates them. pg-sync's transform does
  not currently mirror that "global doc" pathway.

## CSV output

Columns in `tests/perf-sync/results/<scenario>-<protocol>-<ts>.csv`:

| column | meaning |
|---|---|
| `scenario` | scenario name (`baseline` in Phase A) |
| `protocol` | `pg-sync` |
| `user_id` | username of the virtual user |
| `sync_index` | 0-based sync within the user's scenario flow |
| `kind` | `initial` for the first sync, `ongoing` for subsequent syncs |
| `docs_pulled` | docs the client received from the server this sync |
| `docs_pushed` | always 0 in Phase A (uploads are out of scope) |
| `elapsed_ms` | wall-clock around the sync call |
| `error` | empty on success, error message on failure |

## After editing `api/src/` or `shared-libs/**/src/`

nodemon (driven by `npm run dev-api`) watches both trees and restarts
the API automatically. The log file is diagnostic only; the HTTP socket
is authoritative. After an edit:

```bash
sleep 3                                                              # let nodemon notice
curl -sf -o /dev/null http://medic:password@localhost:5988/medic/    # exit 0 = ready
```

If `curl` exits non-zero for ~60s, the API failed to come back up —
`tail -n 50 tests/perf-sync/logs/perf-api.log` should show the stack
trace. A wrapper for the polling loop lives at
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

Phase A is validated end-to-end by running the CLI against a live
stack — that is the contract. Library-level unit tests inherited from
the mocks-only Phase 1 harness were dropped as part of this rewrite;
the parts that survived (the `pg-sync` shared-lib transform/write code
the smoke test exercises) are unit-tested under
`shared-libs/postgres-sync/test/`:

```bash
npx --prefix shared-libs/postgres-sync mocha 'test/**/*.spec.js'
```
