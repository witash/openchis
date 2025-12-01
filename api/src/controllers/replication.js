const replication = require('../services/replication');
const serverUtils = require('../server-utils');
const db = require('../db');

module.exports = {
  getDocIds: async (req, res) => {
    try {
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
  getChanges: async (req, res) => {
    try {
      const sinceTimestamp = req.query.since ? parseInt(req.query.since) : 0;
      const userCtx = req.userCtx;

      // Get user's facility_id (their associated contacts) - this is an array
      const facilityIds = userCtx?.facility_id;

      if (!facilityIds || !Array.isArray(facilityIds) || facilityIds.length === 0) {
        return serverUtils.error(
          { code: 400, message: 'User must have at least one facility_id' },
          req,
          res
        );
      }

      // Query for all documents changed since the given timestamp
      // Check if subject is a descendant of ANY of the user's facilities (up to 5 levels deep)
      // by joining the contacts table and checking parent relationships
      const query = `
        SELECT DISTINCT ON (md._id) md._id, md._rev, md.timestamp
        FROM medic_documents md
        LEFT JOIN contacts c ON md.subject = c.id
        LEFT JOIN contacts p1 ON c.parent = p1.id
        LEFT JOIN contacts p2 ON p1.parent = p2.id
        LEFT JOIN contacts p3 ON p2.parent = p3.id
        LEFT JOIN contacts p4 ON p3.parent = p4.id
        LEFT JOIN contacts p5 ON p4.parent = p5.id
        WHERE md.timestamp > $2
          AND (
            md.subject = ANY($1)
            OR c.parent = ANY($1)
            OR p1.parent = ANY($1)
            OR p2.parent = ANY($1)
            OR p3.parent = ANY($1)
            OR p4.parent = ANY($1)
            OR md.subject = '_all'
          )
        ORDER BY md._id, md.timestamp DESC
      `;

      const result = await db.postgres.query(query, [facilityIds, sinceTimestamp]);

      const changes = result.rows.map(row => ({
        id: row._id,
        rev: row._rev
      }));

      return res.json({ changes });
    } catch (err) {
      return serverUtils.serverError(err, req, res);
    }
  },
};
