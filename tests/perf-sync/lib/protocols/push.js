'use strict';

// Push driver — ported verbatim from webapp's DBSyncService.replicateToRetry
// (webapp/src/ts/services/db-sync.service.ts).
//
// Uses PouchDB's native `replicate.to(remote, { filter, batch_size })` to
// push local edits up to /medic. The `readOnlyFilter` mirrors webapp's
// implementation: skip forms, translations, design docs, known global doc
// ids, and purged-tombstones. This is the function PouchDB hashes into
// the upward replication checkpoint id, so its toString() is force-blanked
// to match webapp — otherwise minification (or here, our line break) would
// invalidate checkpoints between harness runs.
//
// Pull is the responsibility of the per-protocol pull driver (nairobi.js /
// pg-sync.js). Push is the same wire call for both.

const BATCH_SIZE = 100;

// Mirrors webapp/src/ts/services/db-sync.service.ts:
//   const READ_ONLY_TYPES = ['form', DOC_TYPES.TRANSLATIONS];
//   const READ_ONLY_IDS   = [SERVICE_WORKER_META, SETTINGS, RESOURCES,
//                            PARTNERS, BRANDING, ZSCORE_CHARTS];
//   const DDOC_PREFIX = ['_design/'];
const READ_ONLY_TYPES = ['form', 'translations'];
const READ_ONLY_IDS = [
  'service-worker-meta',
  'settings',
  'resources',
  'partners',
  'branding',
  'zscore-charts',
];
const DDOC_PREFIX = ['_design/'];

const readOnlyFilter = function(doc) {
  const keys = Object.keys(doc);
  if (keys.length === 4 &&
    keys.includes('_id') &&
    keys.includes('_rev') &&
    keys.includes('_deleted') &&
    keys.includes('purged')) {
    return false;
  }
  return (
    READ_ONLY_TYPES.indexOf(doc.type) === -1 &&
    READ_ONLY_IDS.indexOf(doc._id) === -1 &&
    doc._id.indexOf(DDOC_PREFIX) !== 0
  );
};
// PouchDB hashes the filter source into the replication-checkpoint id. The
// webapp force-blanks toString so minification doesn't invalidate existing
// checkpoints; we mirror it to stay bit-identical.
readOnlyFilter.toString = () => '';

const buildAuthFetch = (user, fetchFn) => (url, opts) => {
  const init = Object.assign({}, opts || {});
  const headers = new globalThis.Headers();
  const src = opts && opts.headers;
  if (src) {
    if (typeof src.forEach === 'function') {
      src.forEach((value, name) => headers.set(name, value));
    } else {
      for (const [name, value] of Object.entries(src)) {
        headers.set(name, value);
      }
    }
  }
  headers.set('Authorization', 'Basic ' + Buffer.from(`${user.username}:${user.password}`).toString('base64'));
  init.headers = headers;
  return fetchFn(url, init);
};

const makeRemote = (PouchDB, baseUrl, user) => new PouchDB(`${baseUrl}/medic`, {
  skip_setup: true,
  fetch: buildAuthFetch(user, globalThis.fetch || (() => Promise.reject(new Error('fetch unavailable')))),
});

// Runs the upward replication. Returns the docs-pushed count and the
// per-step wall-clock breakdown. Caller is expected to construct the
// remote PouchDB (push.makeRemote or nairobi.makeRemote share the same
// shape) so that the harness can reuse a single remote across push and
// pull on the same user.
const push = async ({ local, remote, batchSize = BATCH_SIZE }) => {
  const start = Date.now();
  const info = await local.replicate.to(remote, {
    filter: readOnlyFilter,
    batch_size: batchSize,
  });
  return {
    elapsed_ms: Date.now() - start,
    docs_pushed: info && Number.isFinite(info.docs_written) ? info.docs_written : 0,
    last_seq: info && info.last_seq !== undefined ? info.last_seq : null,
  };
};

module.exports = {
  BATCH_SIZE,
  DDOC_PREFIX,
  READ_ONLY_IDS,
  READ_ONLY_TYPES,
  buildAuthFetch,
  makeRemote,
  push,
  readOnlyFilter,
};
