const { addPagination, executeView, postgres } = require('./utils');

const buildQuery = (userContactId, keys, include_docs, limit, skip) => {
  let sql = `
    SELECT
      r.id,
      r.verified,
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
    const verifiedStatuses = keys.map(k => {
      const status = Array.isArray(k) ? k[0] : k;
      // Handle true, false, and undefined/null
      if (status === true) return true;
      if (status === false) return false;
      return null;
    });

    // Check if filtering for null values
    const hasNull = verifiedStatuses.includes(null);
    const nonNullStatuses = verifiedStatuses.filter(s => s !== null);

    if (hasNull && nonNullStatuses.length === 0) {
      sql += ` AND r.verified IS NULL`;
    } else if (!hasNull && nonNullStatuses.length > 0) {
      sql += ` AND r.verified = ANY($2)`;
      params.push(nonNullStatuses);
    } else if (hasNull && nonNullStatuses.length > 0) {
      sql += ` AND (r.verified IS NULL OR r.verified = ANY($2))`;
      params.push(nonNullStatuses);
    }
  }

  sql += ` ORDER BY r.verified ASC NULLS FIRST, r.reported_date ASC`;
  sql = addPagination(sql, limit, skip);

  return { sql, params };
};

const getKey = (row) => [row.verified];

const getValue = (row) => row.reported_date;

// reports_by_verification view
// Key: [verified] - true, false, or undefined
// Value: reported_date
const reports_by_verification = async (userCtx, query) => {
  return executeView(userCtx, query, buildQuery, getKey, getValue);
};

module.exports = reports_by_verification;
