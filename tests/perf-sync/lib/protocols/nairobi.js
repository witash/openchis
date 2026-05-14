'use strict';

// Nairobi protocol driver. Real CHT clients drive sync via the bootstrapper
// in webapp/src/js/bootstrapper/initial-replication.js, which composes
// PouchDB.replicate calls around the get-ids / authorization view dance.
// For the harness we treat the protocol as "PouchDB.replicate(remote, local)"
// — the CHT API and views handle the rest. Authentication is per-request
// Basic Auth on the remote PouchDB instance; we never touch the _session
// cookie flow.

const buildRemoteAuthHeader = (user) => 'Basic ' + Buffer.from(`${user.username}:${user.password}`).toString('base64');

const makeRemote = (PouchDB, baseUrl, user) => {
  return new PouchDB(`${baseUrl}/medic`, {
    skip_setup: true,
    ajax: { timeout: 30000 },
    auth: { username: user.username, password: user.password },
    fetch: (url, opts) => {
      const headers = new (globalThis.Headers || Object)(opts && opts.headers || {});
      if (typeof headers.set === 'function') {
        headers.set('Authorization', buildRemoteAuthHeader(user));
      } else {
        opts = Object.assign({}, opts);
        opts.headers = Object.assign({}, opts.headers, { Authorization: buildRemoteAuthHeader(user) });
      }
      return (globalThis.fetch || (() => Promise.reject(new Error('fetch unavailable'))))(url, Object.assign({}, opts, { headers }));
    },
  });
};

// `replicateFn` lets tests inject a stub instead of calling the real
// PouchDB.replicate. Production code passes `PouchDB.replicate`.
const sync = async ({ remote, local, replicateFn, since }) => {
  const start = Date.now();
  const result = await replicateFn(remote, local, {
    // ongoing syncs pass last_seq if available; initial passes nothing
    since: since === undefined ? undefined : since,
    batch_size: 100,
  });
  const elapsed = Date.now() - start;
  return {
    elapsed_ms: elapsed,
    docs_pulled: result && Number.isFinite(result.docs_written) ? result.docs_written : 0,
    docs_pushed: 0,
    last_seq: result && (result.last_seq !== undefined) ? result.last_seq : null,
  };
};

module.exports = {
  buildRemoteAuthHeader,
  makeRemote,
  sync,
};
