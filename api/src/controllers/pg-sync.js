const crypto = require('crypto');
const logger = require('@medic/logger');
const pgSync = require('../services/pg-sync/pg-sync');
const postgresSync = require('@medic/postgres-sync');
const pgPool = require('../services/postgres-sync');
const serverUtils = require('../server-utils');

// CouchDB assigns revs on write; this endpoint never consults CouchDB, so docs
// that arrive without one get a synthetic first-generation rev. The documents
// table is keyed by (_id, _rev), so a fresh rev per write behaves like a new
// CouchDB revision.
const generateRev = (doc) => doc._rev || `1-${crypto.randomBytes(16).toString('hex')}`;

module.exports = {
  getDocs: async (req, res) => {
    if (!req.userCtx || !req.userCtx.name) {
      return serverUtils.notLoggedIn(req, res);
    }
    try {
      const result = await pgSync.getDocs(req.userCtx);
      return res.json(result);
    } catch (err) {
      return serverUtils.serverError(err, req, res);
    }
  },

  // Bypass CouchDB entirely: transform the posted docs and write them straight
  // to Postgres. Intended for perf-testing the Postgres write path in
  // isolation — no CouchDB round-trip and no offline authorization filtering.
  // Body shape matches _bulk_docs (`{ docs: [...] }`); the response mirrors it
  // (`[{ ok, id, rev }]`) with `{ id, error, reason }` stubs for docs missing
  // an _id.
  writeDocs: async (req, res) => {
    if (!req.userCtx || !req.userCtx.name) {
      return serverUtils.notLoggedIn(req, res);
    }
    const docs = req.body && Array.isArray(req.body.docs) ? req.body.docs : null;
    if (!docs) {
      res.status(400);
      return res.json({ error: 'bad_request', reason: 'POST body must include a `docs` array.' });
    }

    const pool = pgPool.getPool();
    if (!pool) {
      return serverUtils.serverError(
        { code: 503, message: 'postgres-sync not configured (POSTGRES_URL unset)' }, req, res
      );
    }

    const prepared = [];
    const results = [];
    for (const doc of docs) {
      if (!doc || !doc._id) {
        results.push({ error: 'bad_request', reason: 'doc must include _id' });
        continue;
      }
      const rev = generateRev(doc);
      prepared.push({ ...doc, _rev: rev });
      results.push({ ok: true, id: doc._id, rev });
    }

    if (!prepared.length) {
      return res.json(results);
    }

    const t0 = Date.now();
    const profile = { n: prepared.length, transform_ms: 0, lineage_ms: 0, write_ms: 0 };
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await postgresSync.transformAndWrite(prepared, client, profile);
      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        logger.error('pg-sync direct-write: ROLLBACK failed: %o', rollbackErr);
      }
      return serverUtils.serverError(err, req, res);
    } finally {
      client.release();
    }
    logger.info(
      `pg-sync direct-write: n=${profile.n} transform=${profile.transform_ms}ms `
      + `lineage=${profile.lineage_ms}ms write=${profile.write_ms}ms total=${Date.now() - t0}ms`
    );
    return res.json(results);
  },
};
