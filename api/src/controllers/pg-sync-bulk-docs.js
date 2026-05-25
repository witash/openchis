// Write-through interceptor for POST /medic/_bulk_docs.
//
// Postgres has no changes feed; the api mirrors every accepted _bulk_docs
// write to Postgres before returning to the client. CouchDB remains the
// source of truth — a Postgres failure surfaces as a 5xx to the client.

const logger = require('@medic/logger');
const pgSync = require('@medic/postgres-sync');
const pgPool = require('../services/postgres-sync');

// Pick out the subset of the original request docs that CouchDB actually
// accepted, so we can mirror only those. Handles both `_bulk_docs` response
// shapes:
//
//  - Default (new_edits=true): response is the per-doc array
//    `[{ ok: true, id, rev }, ...]` (or `{ id, error, reason }` for failures).
//
//  - Replication (new_edits=false): response is a sparse array of error
//    entries only — successful docs aren't echoed back. Successful docs keep
//    their source `_rev` from the request body.
const acceptedDocsFromResponse = (originalDocs, responseBody, newEdits) => {
  if (!Array.isArray(originalDocs) || !originalDocs.length) {
    return [];
  }
  if (!Array.isArray(responseBody)) {
    return [];
  }

  if (newEdits === false) {
    const failed = new Set();
    for (const entry of responseBody) {
      if (entry && entry.error) {
        failed.add(entry.id);
      }
    }
    return originalDocs.filter(d => d && d._id && !failed.has(d._id));
  }

  const byId = new Map();
  for (const doc of originalDocs) {
    if (doc && doc._id) {
      byId.set(doc._id, doc);
    }
  }
  const accepted = [];
  for (const entry of responseBody) {
    if (!entry || !entry.ok || !entry.id) {
      continue;
    }
    const doc = byId.get(entry.id);
    if (!doc) {
      continue;
    }
    accepted.push({ ...doc, _rev: entry.rev || doc._rev });
  }
  return accepted;
};

// Capture middleware. Mounts BEFORE onlineUserPassThrough so it runs for
// both online and offline users. Snapshots the original (pre-filter) docs
// because bulkDocs.request may have rewritten `req.body.docs` by the time
// the response handler runs.
const capture = (req, res, next) => {
  const body = req.body || {};
  res.pgSyncOriginalDocs = Array.isArray(body.docs) ? body.docs : [];
  res.pgSyncNewEdits = body.new_edits;
  res.pgSyncMirror = mirror;
  next();
};

// Run the postgres write. Called from the proxyForAuth `proxyRes` handler
// after the CouchDB response is parsed. Throws on Postgres failure so the
// caller can map to a 5xx response.
const mirror = async (req, res, body) => {
  const originalDocs = res.pgSyncOriginalDocs || [];
  if (!originalDocs.length) {
    return;
  }
  const accepted = acceptedDocsFromResponse(originalDocs, body, res.pgSyncNewEdits);
  if (!accepted.length) {
    return;
  }

  const pool = pgPool.getPool();
  if (!pool) {
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await pgSync.transformAndWrite(accepted, client);
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error('pg-sync: ROLLBACK failed: %o', rollbackErr);
    }
    throw err;
  } finally {
    client.release();
  }
};

module.exports = {
  capture,
  mirror,
  _acceptedDocsFromResponse: acceptedDocsFromResponse,
};
