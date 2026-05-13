# Project Overview

This is a monorepo with three main components and a shared library system.

## Architecture

- **api/** — Node.js web server handling external requests. Connects to CouchDB.
- **webapp/** — Frontend code used in browsers (by "online users") and in Android via WebView (by "offline users").
- **sentinel/** — Background processing service.
- **shared-libs/** — Each subdirectory is a standalone Node module containing code shared across multiple projects.

### Notable Shared Libraries

- **cht-datasource** — REST API layer usable by both online and offline users.

## Online vs Offline Users

- **Offline users** query a local PouchDB database on their device. Documents are synced based on authentication rules; once synced, they work without a connection to the API or remote database.
- **Online users** query CouchDB directly and have access to all documents.

## Source Code Locations

When using `grep` or `find` to search source code, use these directories:

```
api/src/
webapp/src/
sentinel/src/
shared-libs/*/src
.scripts/
```

### External Codebases

For references to views or cross-project usage, also search:

```
../cht-conf/src/
../cht-android/src/
../support-scripts/
../cht-user-management/scripts/
../cht-user-management/src/
```

## CouchDB Views

View definitions live in `ddocs/[database-name]/views/` as a flat directory per database. The mapping of views to design documents is defined in `VIEWS_BY_DDOC` in `shared-libs/constants/src/index.js`. The build script `scripts/build/assemble-views.js` copies views into the correct ddoc directories at build time.

Key view locations:

- **`ddocs/medic-db/views/`** — All medic database views (35 views across 6 ddocs).

## Tests

### Test Directories

| Category | Directory / Glob | Runner |
|---|---|---|
| API unit tests | `api/tests/mocha/**/*.js` | mocha |
| Sentinel unit tests | `sentinel/tests/**/*.js` | mocha |
| Webapp unit tests (Angular) | `webapp/tests/karma/**/*.spec.ts` | karma (ng test) |
| Webapp unit tests (Mocha) | `webapp/tests/mocha/**/*.spec.js` | mocha |
| Webapp cht-form unit tests | `webapp/web-components/cht-form/tests/karma/**/*.spec.ts` | karma (ng test) |
| Admin unit tests | `admin/tests/unit/**/*.js` | karma |
| Shared-lib unit tests | `shared-libs/*/test/**` | mocha (per-lib) |
| CouchDB unit tests | `couchdb/tests/` | make + docker |
| Nginx unit tests | `nginx/tests/unit/*.spec.js` | mocha + docker |
| Nginx integration tests | `nginx/tests/integration/*.spec.js` | mocha |
| API integration tests | `api/tests/integration/**/*.js` | mocha |
| Integration tests (all) | `tests/integration/!(cht-conf\|sentinel)/**/*.spec.js` + `tests/integration/cht-conf/**/*.spec.js` | mocha |
| Integration tests (sentinel) | `tests/integration/sentinel/**/*.spec.js` | mocha |
| Integration tests (cht-form) | `tests/integration/cht-form/` | wdio |
| E2E tests (desktop) | `tests/e2e/default/**/*.wdio-spec.js` | wdio |
| E2E tests (mobile) | `tests/e2e/default-mobile/**/*.wdio-spec.js` | wdio |
| E2E tests (visual) | `tests/e2e/visual/` | wdio |
| E2E tests (upgrade) | `tests/e2e/upgrade/` | wdio |
| Performance tests | `tests/performance/apdex-score/` | wdio + appium |

### Running Tests Locally

```bash
# Run all unit tests
npm run unit

# Individual unit test suites
npm run unit-api              # API unit tests (mocha)
npm run unit-sentinel         # Sentinel unit tests (mocha)
npm run unit-webapp           # Webapp unit tests (karma + mocha)
npm run unit-admin            # Admin unit tests (karma)
npm run unit-shared-lib       # All shared-lib tests (npm workspaces)
npm run unit-couchdb          # CouchDB tests (docker)
npm run unit-nginx            # Nginx tests (docker)
npm run unit-haproxy          # HAProxy tests (docker)
npm run unit-haproxy-healthcheck

# API integration tests (starts/stops local CouchDB)
npm run integration-api

# Full integration tests (requires service images built)
npm run integration-all-local
npm run integration-sentinel-local

# E2E / WebDriver tests (requires service images built)
npm run wdio-local                    # Desktop e2e
npm run wdio-default-mobile-local     # Mobile e2e
```

### Running Individual Test Files

```bash
# Single API unit test file
UNIT_TEST_ENV=1 npx mocha 'api/tests/mocha/path/to/file.spec.js'

# Single sentinel unit test file
UNIT_TEST_ENV=1 npx mocha 'sentinel/tests/path/to/file.spec.js'

# Single shared-lib test file
cd shared-libs/<lib-name> && npx mocha test/path/to/file.spec.js

# Single webapp mocha test file
cd webapp && UNIT_TEST_ENV=1 npx mocha 'tests/mocha/path/to/file.spec.js'

# Single integration test file (requires running services)
npx mocha 'tests/integration/path/to/file.spec.js' --config tests/integration/.mocharc-all.js

# Single API integration test file
npx mocha 'api/tests/integration/path/to/file.spec.js' --config api/tests/integration/.mocharc.js

# Single e2e spec file
npx wdio run ./tests/e2e/default/wdio.conf.js --spec tests/e2e/default/path/to/file.wdio-spec.js
```

