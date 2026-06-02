'use strict';

// Pg-sync pull driver — ported verbatim from webapp's PgReplicationService
// (webapp/src/ts/services/pg-replication.service.ts).
//
// Wire shape:
//   POST /api/v1/pg-sync { since: <bigint> }
//   -> { docs: [...], last_seq: <bigint> }
//
// Two notable webapp-faithful details:
//   1. The cursor lives at `_local/medic-pg-sync-state` (same id as webapp).
//   2. The response `docs` array is fed to `bulkDocs(docs, {new_edits:false})`
//      whole — PouchDB handles `_deleted: true` entries the same way as
//      live docs. No partition step.

const STATE_DOC_ID = '_local/medic-pg-sync-state';

const buildAuthHeader = (user) => 'Basic ' + Buffer.from(`${user.username}:${user.password}`).toString('base64');

const getStateDoc = async (local) => {
  try {
    return await local.get(STATE_DOC_ID);
  } catch (err) {
    if (err && (err.status === 404 || err.name === 'not_found')) {
      return { _id: STATE_DOC_ID };
    }
    throw err;
  }
};

const setLastSeq = async (local, existing, seq) => {
  if (seq === undefined || seq === null) {
    return;
  }
  const next = Object.assign({}, existing, { last_seq: seq });
  await local.put(next);
};

const callServer = async ({ fetchFn, baseUrl, user, since }) => {
  const httpStart = Date.now();
  const res = await fetchFn(`${baseUrl}/api/v1/pg-sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: buildAuthHeader(user),
    },
    body: JSON.stringify({ since }),
  });
  if (!res || !res.ok) {
    const status = res && res.status;
    const text = res && typeof res.text === 'function' ? await res.text() : '';
    throw new Error(`pg-sync HTTP failed status=${status} body=${text}`);
  }
  const body = await res.json();
  const httpElapsed = Date.now() - httpStart;
  return { body, httpElapsed };
};

const applyDocs = async (local, docs) => {
  if (!docs.length) {
    return 0;
  }
  const bulkStart = Date.now();
  await local.bulkDocs(docs, { new_edits: false });
  return Date.now() - bulkStart;
};

const sync = async ({ local, baseUrl, user, fetchFn }) => {
  const start = Date.now();
  const state = await getStateDoc(local);
  const since = state.last_seq === undefined || state.last_seq === null ? 0 : state.last_seq;

  let httpElapsed = 0;
  let bulkElapsed = 0;
  let body;
  try {
    const r = await callServer({ fetchFn, baseUrl, user, since });
    body = r.body;
    httpElapsed = r.httpElapsed;
  } catch (err) {
    // Mid-sync failure must leave _local state untouched so a retry will
    // ask for the same `since` again.
    err.partial = { httpElapsed };
    throw err;
  }

  const docs = Array.isArray(body && body.docs) ? body.docs : [];
  try {
    bulkElapsed = await applyDocs(local, docs);
  } catch (err) {
    err.partial = { httpElapsed, bulkElapsed };
    throw err;
  }

  await setLastSeq(local, state, body.last_seq);

  return {
    elapsed_ms: Date.now() - start,
    docs_pulled: docs.length,
    last_seq: body.last_seq,
    breakdown: {
      http_ms: httpElapsed,
      bulk_ms: bulkElapsed,
    },
  };
};

module.exports = {
  STATE_DOC_ID,
  applyDocs,
  buildAuthHeader,
  callServer,
  getStateDoc,
  setLastSeq,
  sync,
};
