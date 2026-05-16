'use strict';

// Set-up phase for the perf harness.
//
// Calls into the sibling `test-data-generator` repo to populate CouchDB
// with N CHW subtrees (district_hospital → health_center → household →
// {patients, chw}). Each CHW comes with its own _users + user-settings
// + telemetry + 100 tasks + one pregnancy-danger-sign report — the
// canonical many-users shape — but with the CHW username overridden to
// `perf-chw-<runId>-<i>` so the runner can sign in by index.
//
// test-data-generator is ESM and lives outside this repo, so we load it
// (and the perf-many-users design wrapper) with dynamic `import()`.
// `path.resolve(__dirname, …)` is runtime-resolved, so we can probe
// multiple candidate locations and pick the one that exists — the same
// harness then works whether checked out at `openchis/tests/perf-sync`
// or inside a `.agents/<id>` worktree.

const fs = require('fs');
const path = require('path');

const DEFAULT_TDG_REL_PATHS = [
  // Worktree layout: openchis/.agents/<id>/tests/perf-sync/lib/setup.js
  '../../../../../../test-data-generator',
  // Merged-into-openchis layout: openchis/tests/perf-sync/lib/setup.js
  '../../../../test-data-generator',
];

const resolveTdgRoot = (overrides = []) => {
  const candidates = [...overrides, ...DEFAULT_TDG_REL_PATHS]
    .map((rel) => path.resolve(__dirname, rel));
  if (process.env.PERF_SYNC_TDG_PATH) {
    candidates.unshift(path.resolve(process.env.PERF_SYNC_TDG_PATH));
  }
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      return candidate;
    }
  }
  throw new Error(
    'perf-sync setup: cannot locate test-data-generator. ' +
    'Checked: ' + candidates.join(', ') + '. ' +
    'Set PERF_SYNC_TDG_PATH to override.',
  );
};

const buildCouchUrl = ({ baseUrl, admin }) => {
  const url = new URL(baseUrl);
  url.username = encodeURIComponent(admin.username);
  url.password = encodeURIComponent(admin.password);
  // test-data-generator's environment.js strips the path off COUCH_URL
  // back to the origin, so we don't need to append /medic here.
  return url.toString();
};

// Pure function exported so it can be unit-tested without filesystem IO.
const stitchPerfUsernames = ({ docs, runId, userCount }) => {
  const chws = docs.filter((d) => d && d.type === 'person' && d.role === 'chw');
  if (chws.length !== userCount) {
    throw new Error(
      `perf-sync setup: expected ${userCount} CHW docs, got ${chws.length}`,
    );
  }
  return chws.map((d) => ({ username: d.username, contact_id: d._id }));
};

// `_bulk_docs` ignores conflicts silently in test-data-generator's doc-writer,
// so a repeat run with the same runId leaves the user/user-settings doc
// pointing at the **previous** run's CHW and hierarchy. That stale facility_id
// is no longer in Postgres and `req.userCtx` resolves to ids the pg-sync
// endpoint cannot authorize against. Delete the user records before each run
// so the fresh CHW's facility_id / contact_id land in CouchDB.
const cleanupStaleUserDocs = async ({ baseUrl, admin, runId, userCount, fetchFn = globalThis.fetch }) => {
  const auth = 'Basic ' + Buffer.from(`${admin.username}:${admin.password}`).toString('base64');
  const headers = { Authorization: auth, 'Content-Type': 'application/json' };
  const base = baseUrl.replace(/\/+$/, '');
  const dbs = ['_users', 'medic'];
  for (let i = 0; i < userCount; i++) {
    const userDocId = `org.couchdb.user:perf-chw-${runId}-${i}`;
    for (const db of dbs) {
      const url = `${base}/${db}/${encodeURIComponent(userDocId)}`;
      const head = await fetchFn(url, { method: 'HEAD', headers });
      if (head.status === 404) {
        continue;
      }
      if (!head.ok) {
        throw new Error(`perf-sync setup: HEAD ${url} → ${head.status}`);
      }
      const rev = (head.headers.get('etag') || '').replace(/^"|"$/g, '');
      if (!rev) {
        throw new Error(`perf-sync setup: missing ETag on HEAD ${url}`);
      }
      const del = await fetchFn(`${url}?rev=${encodeURIComponent(rev)}`, { method: 'DELETE', headers });
      if (!del.ok) {
        throw new Error(`perf-sync setup: DELETE ${url} → ${del.status}`);
      }
    }
  }
};

const runSetup = async (opts) => {
  const {
    baseUrl,
    admin,
    userCount,
    runId,
    importDocs,    // injectable for tests
    importDesign,  // injectable for tests
    importUpstream, // injectable for tests
    tdgPaths,
    cleanupFn = cleanupStaleUserDocs,
    env = process.env,
  } = opts;

  if (!baseUrl || !admin || !admin.username) {
    throw new Error('perf-sync setup: baseUrl + admin credentials required');
  }
  if (!Number.isFinite(userCount) || userCount <= 0) {
    throw new Error('perf-sync setup: userCount must be a positive integer');
  }
  if (!runId) {
    throw new Error('perf-sync setup: runId required');
  }

  await cleanupFn({ baseUrl, admin, runId: String(runId), userCount });

  env.COUCH_URL = buildCouchUrl({ baseUrl, admin });

  const tdgRoot = resolveTdgRoot(tdgPaths);

  const loadDocs = importDocs
    || (() => import(path.resolve(tdgRoot, 'built/docs.js')));
  const loadDesign = importDesign
    || (() => import(path.resolve(__dirname, '../designs/perf-one-user.js')));
  const loadUpstream = importUpstream
    || (() => import(path.resolve(tdgRoot, 'sample-designs/one-user.js')));

  const [{ Docs }, designModule, upstream] = await Promise.all([
    loadDocs(),
    loadDesign(),
    loadUpstream(),
  ]);

  designModule.configure({
    upstreamDesign: upstream.default,
    userCount,
    runId: String(runId),
  });

  const context = { username: admin.username };
  const designs = designModule.default(context);

  await Docs.createDocs(designs);

  return {
    runId: String(runId),
    userCount,
    usernames: Array.from({ length: userCount }, (_, i) => `perf-chw-${runId}-${i}`),
  };
};

module.exports = {
  buildCouchUrl,
  cleanupStaleUserDocs,
  runSetup,
  resolveTdgRoot,
  stitchPerfUsernames,
};
