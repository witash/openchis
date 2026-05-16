'use strict';

// Nairobi protocol driver — mirrors the real CHT bootstrapper at
// webapp/src/js/bootstrapper/initial-replication.js:
//
//   1. GET /api/v1/replication/get-ids  -> { doc_ids_revs, last_seq, ... }
//   2. diff against the local PouchDB's allDocs to drop already-present revs
//   3. for each batch of BATCH_SIZE missing pairs:
//        POST /medic/_bulk_get?revs=true&attachments=true { docs: batch }
//        local.bulkDocs(docs, { new_edits: false })
//
// Earlier versions of this file called PouchDB.replicate(remote, local)
// which pulled via /medic/_changes. CHT's _changes proxy filters every
// doc in the medic db per-user, so for a fresh test user with no
// authorized docs it scans the entire database — effectively an infinite
// loop. Real online clients never bootstrap via _changes; we don't either.
//
// Ongoing syncs (kind: 'ongoing' with a since cursor) still use
// PouchDB.replicate because by then the user has bootstrapped and the
// _changes feed only carries the delta from `since`.

const BATCH_SIZE = 100;

const buildAuthHeader = (user) => 'Basic ' + Buffer.from(`${user.username}:${user.password}`).toString('base64');

// PouchDB's HTTP adapter calls our fetch with `opts.headers` set to a
// node-fetch Headers instance (pouchdb-adapter-http/lib/index.js:196).
// node-fetch v2 stores entries under a Symbol-keyed internal slot, so a
// plain Object.assign loses every header PouchDB already set
// (Content-Type, Accept, …) and undici then rejects the merged init.
// Build a fresh global Headers and copy the source via forEach (or
// Object.entries for plain-object callers like fetchIds /
// fetchBatchDocs).
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
  headers.set('Authorization', buildAuthHeader(user));
  init.headers = headers;
  return fetchFn(url, init);
};

const makeRemote = (PouchDB, baseUrl, user) => new PouchDB(`${baseUrl}/medic`, {
  skip_setup: true,
  fetch: buildAuthFetch(user, globalThis.fetch || (() => Promise.reject(new Error('fetch unavailable')))),
});

const fetchIds = async ({ fetchFn, baseUrl, user }) => {
  const res = await fetchFn(`${baseUrl}/api/v1/replication/get-ids`, {
    headers: { Authorization: buildAuthHeader(user) },
  });
  if (!res || !res.ok) {
    const status = res && res.status;
    const text = res && typeof res.text === 'function' ? await res.text() : '';
    throw new Error(`get-ids failed status=${status} body=${text}`);
  }
  return res.json();
};

const filterMissing = async (local, idsRevs) => {
  const localResp = await local.allDocs();
  const localRevs = new Map();
  for (const row of localResp.rows) {
    if (row && row.value && row.value.rev) {
      localRevs.set(row.id, row.value.rev);
    }
  }
  return idsRevs.filter(({ id, rev }) => localRevs.get(id) !== rev);
};

const fetchBatchDocs = async ({ fetchFn, baseUrl, user, batch }) => {
  const res = await fetchFn(`${baseUrl}/medic/_bulk_get?revs=true&attachments=true`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: buildAuthHeader(user),
    },
    body: JSON.stringify({ docs: batch }),
  });
  if (!res || !res.ok) {
    const status = res && res.status;
    const text = res && typeof res.text === 'function' ? await res.text() : '';
    throw new Error(`_bulk_get failed status=${status} body=${text}`);
  }
  const body = await res.json();
  return (body.results || [])
    .map((r) => r && r.docs && r.docs[0] && r.docs[0].ok)
    .filter(Boolean);
};

const initialSync = async ({ local, baseUrl, user, fetchFn, batchSize = BATCH_SIZE }) => {
  const idsResp = await fetchIds({ fetchFn, baseUrl, user });
  if (idsResp.use_pg_sync) {
    // Server has flipped the flag; the nairobi protocol can't run.
    throw new Error('nairobi: server returned use_pg_sync=true — disable pg_sync to measure this protocol');
  }
  const missing = await filterMissing(local, idsResp.doc_ids_revs || []);
  let pulled = 0;
  for (let i = 0; i < missing.length; i += batchSize) {
    const batch = missing.slice(i, i + batchSize);
    const docs = await fetchBatchDocs({ fetchFn, baseUrl, user, batch });
    if (docs.length) {
      await local.bulkDocs(docs, { new_edits: false });
      pulled += docs.length;
    }
  }
  return { docs_pulled: pulled, last_seq: idsResp.last_seq };
};

const ongoingSync = async ({ remote, local, replicateFn, since }) => {
  const result = await replicateFn(remote, local, {
    since,
    batch_size: BATCH_SIZE,
  });
  return {
    docs_pulled: result && Number.isFinite(result.docs_written) ? result.docs_written : 0,
    last_seq: result && (result.last_seq !== undefined) ? result.last_seq : since,
  };
};

const sync = async ({ remote, local, replicateFn, baseUrl, user, fetchFn, since }) => {
  const start = Date.now();
  // `since` distinguishes the two modes: initial sync has no cursor; an
  // ongoing sync resumes from a known seq.
  const out = since === undefined
    ? await initialSync({ local, baseUrl, user, fetchFn })
    : await ongoingSync({ remote, local, replicateFn, since });
  return {
    elapsed_ms: Date.now() - start,
    docs_pulled: out.docs_pulled,
    docs_pushed: 0,
    last_seq: out.last_seq,
  };
};

module.exports = {
  BATCH_SIZE,
  buildAuthFetch,
  buildAuthHeader,
  fetchBatchDocs,
  fetchIds,
  filterMissing,
  initialSync,
  makeRemote,
  ongoingSync,
  sync,
};
