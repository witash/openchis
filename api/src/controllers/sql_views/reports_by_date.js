const { addPagination, executeView, postgres } = require('./utils');

const buildQuery = (userContactId, keys, include_docs, limit, skip) => {
  let sql = `
    SELECT
      r.id,
      r.reported_date
      ${include_docs ? ', d.doc' : ''}
    FROM reports r
    ${include_docs ? 'INNER JOIN medic_documents d ON d._id = r.id' : ''}
    INNER JOIN contacts c ON r.subject = c.id
    WHERE r.form IS NOT NULL
      AND (c.lineage @> ARRAY[$1] OR c.id = $1)
  `;

  const params = [userContactId];

  if (keys && keys.length > 0) {
    const dates = keys.map(k => Array.isArray(k) ? k[0] : k).filter(d => d !== undefined);
    if (dates.length > 0) {
      sql += ` AND r.reported_date = ANY($2)`;
      params.push(dates);
    }
  }

  sql += ` ORDER BY r.reported_date ASC`;
  sql = addPagination(sql, limit, skip);

  return { sql, params };
};

const getKey = (row) => [row.reported_date];

const getValue = (row) => row.reported_date;

// reports_by_date view
// Key: [reported_date]
// Value: reported_date
const reports_by_date = async (userCtx, query) => {
  return executeView(userCtx, query, buildQuery, getKey, getValue);
};

module.exports = reports_by_date;
