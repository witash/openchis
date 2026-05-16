// Write-through interceptor for POST /medic/_bulk_docs.
//
// Sentinel's changes-feed mirror is eventually-consistent: a doc lands in
// CouchDB before it shows up in Postgres. If a client uploads and then
// immediately polls /api/v1/pg-sync, the just-uploaded docs may be missing
// and the client may advance its `last_seq` past the gap. To close that race
// for the replication-upload path, the api mirrors every accepted _bulk_docs
// write to Postgres before returning to the client.
//
// Sentinel still mirrors everything else (single-doc PUT/POST, non-api
// writes). Where both paths cover the same (_id, _rev), the shared-lib's
// ON CONFLICT DO NOTHING on `medic_documents` resolves it: both writers
// compute identical row contents, so whoever lands first wins and the loser
// silently no-ops.

const logger = require('@medic/logger');
const pgSync = require('@medic/postgres-sync');
const pgPool = require('../services/postgres-sync');

// Pick out the subset of the original request docs that CouchDB actually
// accepted, so we can mirror only those. Handles both `_bulk_docs` response
// shapes:
//
//  - Default (new_edits=true): response is the per-doc array
//    `[{ ok: true, id, rev }, ...]` (or `{ id, error, reason }` for failures),
//    parallel to the request docs.
//
//  - Replication (new_edits=false): response is a sparse array of error
//    entries only — successful docs aren't echoed back. Successful docs keep
//    their source `_rev` from the request body.
//
// For offline users, bulkDocs `formatResults` may have re-spliced
// `forbidden` stubs into the response. Those carry `error: 'forbidden'` so
// they fail the `ok` check; they don't land in the accepted set.
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
// from the request body — by the time the response handler runs,
// bulkDocs.request may have rewritten `req.body.docs` to the filtered
// subset.
const capture = (req, res, next) => {
  const body = req.body || {};
  res.pgSyncOriginalDocs = Array.isArray(body.docs) ? body.docs : [];
  res.pgSyncNewEdits = body.new_edits;
  res.pgSyncMirror = mirror;
  next();
};

// Run the postgres write. Called from the proxyForAuth `proxyRes` handler
// after the CouchDB response has been parsed and `res.interceptResponse`
// (if any) has run. Throws on Postgres failure so the caller can map to a
// 5xx response — CouchDB has already accepted the write, that's an accepted
// PoC anomaly (sentinel will catch up).
const mirror = async (req, res, body) => {
  const originalDocs = res.pgSyncOriginalDocs || [];
  if (!originalDocs.length) {
    return { mirrored: 0 };
  }
  const accepted = acceptedDocsFromResponse(originalDocs, body, res.pgSyncNewEdits);
  if (!accepted.length) {
    return { mirrored: 0 };
  }

  const pool = pgPool.getPool();
  if (!pool) {
    // POSTGRES_URL not configured — skip mirroring entirely. Sentinel's
    // mirror (when configured) handles the catch-up.
    return { mirrored: 0, skipped: 'no-postgres-url' };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await pgSync.transformAndWrite(accepted, client);
    await client.query('COMMIT');
    return { mirrored: accepted.length };
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
