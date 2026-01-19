const { addPagination, executeView, postgres } = require('./utils');

const buildQuery = (userContactId, keys, include_docs, limit, skip) => {
  let sql = `
    SELECT
      r.id,
      r.subject,
      r.reported_date
      ${include_docs ? ', d.doc' : ''}
    FROM reports r
    ${include_docs ? 'INNER JOIN medic_documents d ON d._id = r.id' : ''}
    INNER JOIN contacts c ON r.subject = c.id
    WHERE r.form IS NOT NULL
      AND r.subject IS NOT NULL
      AND (c.lineage @> ARRAY[$1] OR c.id = $1)
  `;

  const params = [userContactId];

  if (keys && keys.length > 0) {
    const subjects = keys.map(k => k).filter(Boolean);
    if (subjects.length > 0) {
      sql += ` AND r.subject = ANY($2)`;
      params.push(subjects);
    }
  }

  sql += ` ORDER BY r.subject ASC, r.reported_date ASC`;
  sql = addPagination(sql, limit, skip);

  return { sql, params };
};

const getKey = (row) => row.subject;

const getValue = (row) => row.reported_date;

// reports_by_subject view
// Key: subject
// Value: reported_date
const reports_by_subject = async (userCtx, query) => {
  return executeView(userCtx, query, buildQuery, getKey, getValue);
};

module.exports = reports_by_subject;
