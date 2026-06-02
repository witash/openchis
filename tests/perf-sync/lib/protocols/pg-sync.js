'use strict';

// Pg-sync driver — both directions bypass CouchDB entirely on this branch.
//
//   pull:  POST /api/v1/pg-sync        -> { docs: [...] }
//   push:  POST /api/v1/pg-sync/write  { docs: [...] } -> [{ ok, id, rev }]
//
// Full-snapshot semantics: this branch's /api/v1/pg-sync returns the entire
// authorized doc set on every call — there is no server cursor and no
// `last_seq` in the response. So there is no `since` to send and no `_local`
// state doc to maintain; each pull re-pulls everything and `bulkDocs(docs,
// {new_edits:false})` no-ops the docs already present locally.
//
// Push collects the local edits not yet sent (tracked by a per-db changes
// checkpoint, `local.__pgPushSince`) and writes them straight to Postgres via
// the direct-write endpoint, never touching CouchDB. The read-only filter is
// shared with the CouchDB push driver so both protocols push the same docs.

const push = require('./push');

const buildAuthHeader = (user) => 'Basic ' + Buffer.from(`${user.username}:${user.password}`).toString('base64');

// ---- pull -----------------------------------------------------------------

const callServer = async ({ fetchFn, baseUrl, user }) => {
  const httpStart = Date.now();
  const res = await fetchFn(`${baseUrl}/api/v1/pg-sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: buildAuthHeader(user),
    },
    body: JSON.stringify({}),
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

  let httpElapsed = 0;
  let bulkElapsed = 0;
  let body;
  try {
    const r = await callServer({ fetchFn, baseUrl, user });
    body = r.body;
    httpElapsed = r.httpElapsed;
  } catch (err) {
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

  // No server cursor: advance the push checkpoint past the just-applied docs
  // so the next push doesn't mistake pulled docs for local edits to upload.
  const info = await local.info();
  local.__pgPushSince = info.update_seq;

  return {
    elapsed_ms: Date.now() - start,
    docs_pulled: docs.length,
    breakdown: {
      http_ms: httpElapsed,
      bulk_ms: bulkElapsed,
    },
  };
};

// ---- push (direct Postgres write) -----------------------------------------

const writeToPg = async ({ fetchFn, baseUrl, user, docs }) => {
  const res = await fetchFn(`${baseUrl}/api/v1/pg-sync/write`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: buildAuthHeader(user),
    },
    body: JSON.stringify({ docs }),
  });
  if (!res || !res.ok) {
    const status = res && res.status;
    const text = res && typeof res.text === 'function' ? await res.text() : '';
    throw new Error(`pg-sync write HTTP failed status=${status} body=${text}`);
  }
  return res.json();
};

// Collect local edits since the last push checkpoint, applying the same
// read-only filter the CouchDB push uses. Deletions are sent as tombstones.
const collectPending = async (local, since) => {
  const result = await local.changes({ since, include_docs: true });
  const docs = [];
  for (const change of (result.results || [])) {
    const doc = change.doc;
    if (!doc) {
      continue;
    }
    if (change.deleted) {
      docs.push({ _id: doc._id, _rev: doc._rev, _deleted: true });
      continue;
    }
    if (push.readOnlyFilter(doc)) {
      docs.push(doc);
    }
  }
  return { docs, lastSeq: result.last_seq };
};

const pushDocs = async ({ local, baseUrl, user, fetchFn }) => {
  const start = Date.now();
  const since = local.__pgPushSince || 0;
  let docs = [];
  let lastSeq = since;
  try {
    const collected = await collectPending(local, since);
    docs = collected.docs;
    lastSeq = collected.lastSeq;
    if (docs.length) {
      await writeToPg({ fetchFn, baseUrl, user, docs });
    }
  } catch (err) {
    err.partial = { docs_pushed: 0 };
    throw err;
  }

  local.__pgPushSince = lastSeq;
  return {
    elapsed_ms: Date.now() - start,
    docs_pushed: docs.length,
    last_seq: lastSeq,
  };
};

module.exports = {
  applyDocs,
  buildAuthHeader,
  callServer,
  collectPending,
  push: pushDocs,
  sync,
  writeToPg,
};
