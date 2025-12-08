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
      const sinceSeq = req.query.since ? parseInt(req.query.since) : 0;
      const limit = req.query.limit ? parseInt(req.query.limit) : 100;
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

      // Query for documents changed since the given postgres sequence, ordered by seq for pagination
      // seq is a postgres-native auto-incrementing BIGSERIAL (not CouchDB sequence which is a string)
      // Check if subject is a descendant of ANY of the user's facilities (up to 5 levels deep)
      // Returns full docs directly instead of just id/rev pairs
      const query = `
        SELECT DISTINCT ON (md._id) md._id, md._rev, md.doc, md.seq
        FROM medic_documents md
        LEFT JOIN contacts c ON md.subject = c.id
        LEFT JOIN contacts p1 ON c.parent = p1.id
        LEFT JOIN contacts p2 ON p1.parent = p2.id
        LEFT JOIN contacts p3 ON p2.parent = p3.id
        LEFT JOIN contacts p4 ON p3.parent = p4.id
        LEFT JOIN contacts p5 ON p4.parent = p5.id
        WHERE md.seq > $2
          AND (
            md.subject = ANY($1)
            OR c.parent = ANY($1)
            OR p1.parent = ANY($1)
            OR p2.parent = ANY($1)
            OR p3.parent = ANY($1)
            OR p4.parent = ANY($1)
            OR md.subject = '_all'
            OR md.subject IS NULL
          )
        ORDER BY md._id, md.seq DESC
        LIMIT $3
      `;

      const result = await db.postgres.query(query, [facilityIds, sinceSeq, limit]);

      const docs = result.rows.map(row => row.doc);
      const docIds = docs.map(doc => doc._id);

      // Fetch attachments for these docs
      if (docIds.length > 0) {
        const attachmentsResult = await db.postgres.query(
          'SELECT doc_id, name, content_type, digest, length, revpos, data FROM attachments WHERE doc_id = ANY($1)',
          [docIds]
        );

        // Group attachments by doc_id
        const attachmentsByDocId = {};
        for (const att of attachmentsResult.rows) {
          if (!attachmentsByDocId[att.doc_id]) {
            attachmentsByDocId[att.doc_id] = {};
          }
          attachmentsByDocId[att.doc_id][att.name] = {
            content_type: att.content_type,
            digest: att.digest,
            length: att.length,
            revpos: att.revpos,
            data: att.data
          };
        }

        // Merge attachments into docs
        for (const doc of docs) {
          if (attachmentsByDocId[doc._id]) {
            doc._attachments = attachmentsByDocId[doc._id];
          }
        }
      }

      // Get the max seq from results - seq is postgres-native integer so max() works correctly
      const seqValues = result.rows.map(row => parseInt(row.seq));
      const lastSeq = seqValues.length > 0 ? Math.max(...seqValues) : null;

      return res.json({ docs, last_seq: lastSeq });
    } catch (err) {
      return serverUtils.serverError(err, req, res);
    }
  },
};
