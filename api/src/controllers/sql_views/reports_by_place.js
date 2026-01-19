const { addPagination, executeView, postgres } = require('./utils');

const buildQuery = (userContactId, keys, include_docs, limit, skip) => {
  let sql = `
    SELECT
      r.id,
      lineage_ids.id as place_id,
      r.reported_date
      ${include_docs ? ', d.doc' : ''}
    FROM reports r
    ${include_docs ? 'INNER JOIN medic_documents d ON d._id = r.id' : ''}
    INNER JOIN contacts c ON r.contact = c.id
    CROSS JOIN unnest(c.lineage) AS lineage_ids(id)
    WHERE r.form IS NOT NULL
      AND (c.lineage @> ARRAY[$1] OR c.id = $1)
  `;

  const params = [userContactId];

  if (keys && keys.length > 0) {
    const placeIds = keys.map(k => Array.isArray(k) ? k[0] : k).filter(Boolean);
    if (placeIds.length > 0) {
      sql += ` AND lineage_ids.id = ANY($2)`;
      params.push(placeIds);
    }
  }

  sql += ` ORDER BY place_id ASC, r.reported_date ASC`;
  sql = addPagination(sql, limit, skip);

  return { sql, params };
};

const getKey = (row) => [row.place_id];

const getValue = (row) => row.reported_date;

// reports_by_place view
// Key: [place_id]
// Value: reported_date
// Emits for each ancestor of the report's contact
const reports_by_place = async (userCtx, query) => {
  return executeView(userCtx, query, buildQuery, getKey, getValue);
};

module.exports = reports_by_place;
