'use strict';

// Nairobi pull driver — ported verbatim from webapp's ReplicationService
// (webapp/src/ts/services/replication.service.ts).
//
// Sequence per pull:
//   1. GET /api/v1/replication/get-ids      -> { doc_ids_revs, use_pg_sync }
//   2. local.allDocs() to build the localIdRevMap
//   3. Missing docs: for each batch of 100 from remoteDocIdsRevs that the
//      local doesn't have at the same rev, POST /medic/_bulk_get and
//      bulkDocs(new_edits: false) the results
//   4. Deletes: for each batch of 100 local ids not in remoteIdRevMap,
//      POST /api/v1/replication/get-deletes and bulkDocs the tombstones
//
// The "ongoing" path no longer uses PouchDB.replicate via the _changes
// feed — the webapp shipped this algorithm for both initial and ongoing
// syncs. Repeat calls naturally cheapen because filterMissing collapses
// to an empty list once the local mirror is up to date.

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

const buildLocalIdRevMap = async (local) => {
  const localDocs = await local.allDocs();
  const map = {};
  for (const row of localDocs.rows) {
    if (row && row.value && row.value.rev) {
      map[row.id] = row.value.rev;
    }
  }
  return map;
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

const getMissingDocs = async ({ local, fetchFn, baseUrl, user, localIdRevMap, remoteDocIdsRevs }) => {
  const toDownload = remoteDocIdsRevs.filter(({ id, rev }) => !localIdRevMap[id] || localIdRevMap[id] !== rev);
  const total = toDownload.length;
  for (let i = 0; i < toDownload.length; i += BATCH_SIZE) {
    const batch = toDownload.slice(i, i + BATCH_SIZE);
    const docs = await fetchBatchDocs({ fetchFn, baseUrl, user, batch });
    if (docs.length) {
      await local.bulkDocs(docs, { new_edits: false });
    }
  }
  return total;
};

const fetchDeleteList = async ({ fetchFn, baseUrl, user, batch }) => {
  const res = await fetchFn(`${baseUrl}/api/v1/replication/get-deletes`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: buildAuthHeader(user),
    },
    body: JSON.stringify({ doc_ids: batch }),
  });
  if (!res || !res.ok) {
    const status = res && res.status;
    const text = res && typeof res.text === 'function' ? await res.text() : '';
    throw new Error(`get-deletes failed status=${status} body=${text}`);
  }
  const body = await res.json();
  return body.doc_ids || [];
};

const getDeletesAndPurges = async ({ local, fetchFn, baseUrl, user, localIdRevMap, remoteIdRevMap }) => {
  const missingRemoteIds = Object.keys(localIdRevMap).filter((id) => !remoteIdRevMap[id]);
  let deleted = 0;
  for (let i = 0; i < missingRemoteIds.length; i += BATCH_SIZE) {
    const batch = missingRemoteIds.slice(i, i + BATCH_SIZE);
    const idsToDelete = await fetchDeleteList({ fetchFn, baseUrl, user, batch });
    if (!idsToDelete.length) {
      continue;
    }
    const tombstones = idsToDelete.map((id) => ({
      _id: id,
      _rev: localIdRevMap[id],
      _deleted: true,
      purged: true,
    }));
    await local.bulkDocs(tombstones);
    deleted += tombstones.length;
  }
  return deleted;
};

const sync = async ({ local, baseUrl, user, fetchFn }) => {
  const start = Date.now();
  const idsResp = await fetchIds({ fetchFn, baseUrl, user });
  if (idsResp && idsResp.use_pg_sync) {
    throw new Error('nairobi: server returned use_pg_sync=true — disable pg_sync to measure this protocol');
  }
  const remoteDocIdsRevs = (idsResp && idsResp.doc_ids_revs) || [];
  const localIdRevMap = await buildLocalIdRevMap(local);
  const remoteIdRevMap = {};
  for (const { id, rev } of remoteDocIdsRevs) {
    remoteIdRevMap[id] = rev;
  }
  const downloaded = await getMissingDocs({ local, fetchFn, baseUrl, user, localIdRevMap, remoteDocIdsRevs });
  const deleted = await getDeletesAndPurges({ local, fetchFn, baseUrl, user, localIdRevMap, remoteIdRevMap });
  return {
    elapsed_ms: Date.now() - start,
    docs_pulled: downloaded + deleted,
    last_seq: idsResp && idsResp.last_seq,
  };
};

module.exports = {
  BATCH_SIZE,
  buildAuthFetch,
  buildAuthHeader,
  buildLocalIdRevMap,
  fetchBatchDocs,
  fetchDeleteList,
  fetchIds,
  getDeletesAndPurges,
  getMissingDocs,
  makeRemote,
  sync,
};
