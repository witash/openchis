'use strict';

// Postgres-backed sync protocol driver.
//
// Wire shape:
//   POST /api/v1/pg-sync { since: <bigint> }
//   -> { docs: [...], last_seq: <bigint> }
//
// Tombstones come back as docs with _deleted: true. We partition them locally
// so that bulkDocs can both upsert the live docs (new_edits: false) and apply
// the deletes. The since cursor is persisted to a _local/ PouchDB doc so
// ongoing syncs resume from the right point.

const STATE_DOC_ID = '_local/perf-pg-sync-state';

const buildAuthHeader = (user) => 'Basic ' + Buffer.from(`${user.username}:${user.password}`).toString('base64');

const readSince = async (local) => {
  try {
    const doc = await local.get(STATE_DOC_ID);
    if (doc && Number.isFinite(Number(doc.last_seq))) {
      return Number(doc.last_seq);
    }
    return 0;
  } catch (err) {
    if (err && (err.status === 404 || err.name === 'not_found')) {
      return 0;
    }
    throw err;
  }
};

const writeSince = async (local, lastSeq) => {
  let existing;
  try {
    existing = await local.get(STATE_DOC_ID);
  } catch (err) {
    if (!(err && (err.status === 404 || err.name === 'not_found'))) {
      throw err;
    }
  }
  const next = Object.assign({}, existing || { _id: STATE_DOC_ID }, { last_seq: lastSeq });
  await local.put(next);
};

const partitionDocs = (docs) => {
  const upserts = [];
  const deletes = [];
  for (const doc of docs || []) {
    if (doc && doc._deleted) {
      deletes.push(doc);
    } else if (doc) {
      upserts.push(doc);
    }
  }
  return { upserts, deletes };
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

const applyToLocal = async (local, partitioned) => {
  const bulkStart = Date.now();
  if (partitioned.upserts.length) {
    await local.bulkDocs(partitioned.upserts, { new_edits: false });
  }
  if (partitioned.deletes.length) {
    await local.bulkDocs(partitioned.deletes, { new_edits: false });
  }
  return Date.now() - bulkStart;
};

const sync = async ({ local, baseUrl, user, fetchFn }) => {
  const start = Date.now();
  const since = await readSince(local);
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

  const partitioned = partitionDocs(body.docs);
  try {
    bulkElapsed = await applyToLocal(local, partitioned);
  } catch (err) {
    err.partial = { httpElapsed, bulkElapsed };
    throw err;
  }

  const nextSeq = Number(body.last_seq);
  if (Number.isFinite(nextSeq)) {
    await writeSince(local, nextSeq);
  }

  return {
    elapsed_ms: Date.now() - start,
    docs_pulled: (body.docs || []).length,
    docs_pushed: 0,
    last_seq: Number.isFinite(nextSeq) ? nextSeq : since,
    breakdown: {
      http_ms: httpElapsed,
      bulk_ms: bulkElapsed,
    },
  };
};

module.exports = {
  STATE_DOC_ID,
  applyToLocal,
  buildAuthHeader,
  callServer,
  partitionDocs,
  readSince,
  sync,
  writeSince,
};
