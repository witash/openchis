const db = require('../db');
const auth = require('../auth');

module.exports = {
  // Returns all docs from postgres
  // Supports startkey, endkey, keys, include_docs, limit, skip
  // For offline users, applies authorization filtering based on facility_id
  request: async (userCtx, query, body) => {
    const isOnline = auth.isOnlineOnly(userCtx);
    const includeDocs = query?.include_docs === 'true' || query?.include_docs === true;

    // Build base query - get latest revision of each document
    const selectFields = includeDocs
      ? 'md._id as id, md._rev as value_rev, md.doc, (md.doc->>\'_deleted\')::boolean as deleted'
      : 'md._id as id, md._rev as value_rev, (md.doc->>\'_deleted\')::boolean as deleted';

    let sql = `
      SELECT DISTINCT ON (md._id)
        ${selectFields}
      FROM medic_documents md
    `;

    const params = [];
    const whereClauses = [];

    // Apply authorization for offline users only
    if (!isOnline && userCtx && userCtx.facility_id) {
      const facilityIds = Array.isArray(userCtx.facility_id) ? userCtx.facility_id : [userCtx.facility_id];
      params.push(facilityIds);

      whereClauses.push(`(
        md.subject = ANY($${params.length})
        OR md.subject = '_all'
        OR md.subject IS NULL
        OR EXISTS (
          SELECT 1 FROM contacts c
          LEFT JOIN contacts p1 ON c.parent = p1.id
          LEFT JOIN contacts p2 ON p1.parent = p2.id
          LEFT JOIN contacts p3 ON p2.parent = p3.id
          LEFT JOIN contacts p4 ON p3.parent = p4.id
          LEFT JOIN contacts p5 ON p4.parent = p5.id
          WHERE md.subject = c.id
          AND (
            c.parent = ANY($${params.length})
            OR p1.parent = ANY($${params.length})
            OR p2.parent = ANY($${params.length})
            OR p3.parent = ANY($${params.length})
            OR p4.parent = ANY($${params.length})
          )
        )
      )`);
    }

    // Handle specific keys request
    const keys = body?.keys || query?.keys;
    if (keys && Array.isArray(keys)) {
      params.push(keys);
      whereClauses.push(`md._id = ANY($${params.length})`);
    }

    // Handle startkey and endkey (used to get single documents or ranges)
    const startkey = query?.startkey || query?.start_key;
    const endkey = query?.endkey || query?.end_key;

    if (startkey) {
      params.push(startkey);
      whereClauses.push(`md._id >= $${params.length}`);
    }

    if (endkey) {
      params.push(endkey);
      whereClauses.push(`md._id <= $${params.length}`);
    }

    if (whereClauses.length > 0) {
      sql += ` WHERE ${whereClauses.join(' AND ')}`;
    }

    sql += ` ORDER BY md._id, md.timestamp DESC`;

    // Handle limit and skip
    if (query?.limit) {
      params.push(parseInt(query.limit));
      sql += ` LIMIT $${params.length}`;
    }
    if (query?.skip) {
      params.push(parseInt(query.skip));
      sql += ` OFFSET $${params.length}`;
    }

    const result = await db.postgres.query(sql, params);

    // Format response like CouchDB
    return {
      total_rows: result.rows.length,
      offset: query?.skip ? parseInt(query.skip) : 0,
      rows: result.rows.map(row => ({
        id: row.id,
        key: row.id,
        value: {
          rev: row.value_rev
        },
        ...(row.deleted ? { deleted: true } : {}),
        ...(includeDocs && row.doc ? { doc: row.doc } : {})
      }))
    };
  }
};
