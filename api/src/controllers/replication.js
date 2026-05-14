const replication = require('../services/replication/replication');
const serverUtils = require('../server-utils');
const config = require('../config');

// When app_settings.pg_sync.enabled is true, get-ids returns
// { use_pg_sync: true } and skips the legacy id/rev enumeration.
// The client routes that sync through /api/v1/pg-sync instead.
const isPgSyncEnabled = () => Boolean(config.get('pg_sync')?.enabled);

module.exports = {
  getDocIds: async (req, res) => {
    try {
      if (isPgSyncEnabled()) {
        return res.json({ use_pg_sync: true });
      }
      const context = await replication.getContext(req.userCtx);
      const docIdsRevs = await replication.getDocIdsRevPairs(context.docIds);
      return res.json({
        doc_ids_revs: docIdsRevs,
        warn_docs: context.warnDocIds.length,
        last_seq: context.lastSeq,
        warn: context.warn,
        limit: context.limit,
      });
    } catch (err) {
      return serverUtils.serverError(err, req, res);
    }
  },
  getDocIdsToDelete: async (req, res) => {
    const docIds = req.body?.doc_ids;
    try {
      const docIdsToDelete = await replication.getDocIdsToDelete(req.userCtx, docIds);
      return res.json({ doc_ids: docIdsToDelete });
    } catch (err) {
      return serverUtils.serverError(err, req, res);
    }
  },
};
