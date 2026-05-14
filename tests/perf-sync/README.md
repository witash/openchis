# perf-sync

Performance harness that drives N realistic PouchDB clients against a live
CHT install, runs a chosen sync protocol (Nairobi `get-ids` vs the
Postgres-backed `/api/v1/pg-sync`), measures per-sync wall-clock timing, and
emits a CSV plus a stdout summary table.

This is Phase 1 of the harness — the core and the two simplest scenarios.
Heavy-upload, background-writes, and purge scenarios are picked up by
`perf-harness-scenarios` (Phase 2).

## Process model

The harness is a parent + N child processes via `child_process.fork`. Each
child is one virtual user with its own Node event loop, its own in-memory
PouchDB instance, and its own auth context. The parent fans out work,
collects per-sync metrics over IPC, writes the CSV, and prints the
summary. The pattern keeps event loops isolated so a single slow client
doesn't distort the measurement of its peers — single-process async won't
scale past ~50 concurrent before PouchDB's internal locks dominate.

## Prerequisites

- A reachable CHT install (the URL goes in `config.json`).
- Admin credentials with permission to POST `/api/v1/users` — the harness
  creates the test users on setup and deletes them on teardown.
- Node 22.x (matches CHT's engines field).
- Optional: a clear `medic_documents` mirror in Postgres if you want
  pg-sync to start from a known state.

## Configuration

`config.json` (template ships in this directory):

```json
{
  "url": "http://localhost:5988",
  "admin": { "username": "medic", "password": "password" },
  "userPrefix": "perf-test",
  "fixtures": { "reportsPerUser": 500, "personsPerUser": 20 }
}
```

You can override at the command line with `--config=path/to/config.json`.

## Invocation

```bash
node tests/perf-sync/cli.js --help

# baseline: each of N users does one initial sync.
node tests/perf-sync/cli.js baseline --users=50 --protocol=both

# initial-vs-ongoing: warm a fraction up, then a second-round sync across all.
node tests/perf-sync/cli.js initial-vs-ongoing --users=50 --warmed-fraction=0.8 --protocol=both
```

`--protocol` accepts `nairobi`, `pg-sync` (alias `pg`/`postgres`), or `both`.

## CSV output

Results are written to `tests/perf-sync/results/<scenario>-<protocol>-<ts>.csv`:

| column | meaning |
|---|---|
| `scenario` | scenario name (`baseline`, `initial-vs-ongoing`) |
| `protocol` | `nairobi` or `pg-sync` |
| `user_id` | the username of the virtual user |
| `sync_index` | 0-based sync within the user's scenario flow |
| `kind` | `initial` or `ongoing` |
| `docs_pulled` | docs the client received from the server this sync |
| `docs_pushed` | always 0 in Phase 1 (uploads aren't measured yet) |
| `elapsed_ms` | wall-clock around the sync call |
| `error` | empty on success, error message on failure |

A stdout summary follows the run:

```
scenario=baseline protocol=nairobi users=50
  p50=820ms  p95=2410ms  p99=4180ms  throughput=12.1/s  errors=0
scenario=baseline protocol=pg-sync users=50
  p50=180ms  p95=420ms   p99=510ms   throughput=58.3/s  errors=0
```

## Cleanup if a run is interrupted

The harness wraps every scenario in `try/finally` so teardown runs even on
crashes — but if the process is hard-killed, generated users will linger.
Every test user the harness creates is named
`<userPrefix>-<run-id>-<index>`. The default `userPrefix` is `perf-test`.
To list and remove stragglers (admin creds required):

```bash
curl -u "$ADMIN_USER:$ADMIN_PASSWORD" \
  "$CHT_URL/_users/_all_docs?startkey=%22org.couchdb.user%3Aperf-test-%22&endkey=%22org.couchdb.user%3Aperf-test-%5Cufff0%22" \
  | jq -r '.rows[].id' \
  | sed 's|^org.couchdb.user:||' \
  | xargs -n1 -I{} curl -X DELETE -u "$ADMIN_USER:$ADMIN_PASSWORD" "$CHT_URL/api/v1/users/{}"
```

## Tests

The harness binary is end-to-end against a live deployment, but its
library pieces are unit-tested with mocks:

```bash
npx mocha 'tests/perf-sync/test/**/*.spec.js'
```

The unit tests must run without a live CHT or Postgres — they use
`pouchdb-adapter-memory` for in-process PouchDB and `sinon` stubs for
`fetch` and `PouchDB.replicate`.
