const { addPagination, executeView, postgres } = require('./utils');

const buildQuery = (userContactId, keys, include_docs, limit, skip) => {
  let sql = `
    SELECT
      r.id,
      r.has_errors,
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
    // Keys are [true] or [false] for valid/invalid
    // has_errors = true means invalid, so we need to negate
    const validities = keys.map(k => {
      const isValid = Array.isArray(k) ? k[0] : k;
      return !isValid; // Convert valid->has_errors: true(valid)->false(has_errors), false(invalid)->true(has_errors)
    });

    if (validities.length === 1) {
      sql += ` AND r.has_errors = $2`;
      params.push(validities[0]);
    } else if (validities.length > 1) {
      sql += ` AND r.has_errors = ANY($2)`;
      params.push(validities);
    }
  }

  sql += ` ORDER BY r.has_errors ASC, r.reported_date ASC`;
  sql = addPagination(sql, limit, skip);

  return { sql, params };
};

const getKey = (row) => [!row.has_errors]; // Negate has_errors to get validity

const getValue = (row) => row.reported_date;

// reports_by_validity view
// Key: [is_valid] - true if no errors, false if has errors
// Value: reported_date
const reports_by_validity = async (userCtx, query) => {
  return executeView(userCtx, query, buildQuery, getKey, getValue);
};

module.exports = reports_by_validity;
