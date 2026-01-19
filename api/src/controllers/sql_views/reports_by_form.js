const { addPagination, executeView, postgres } = require('./utils');

const buildQuery = (userContactId, keys, include_docs, limit, skip) => {
  let sql = `
    SELECT
      r.id,
      r.form,
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
    const forms = keys.map(k => Array.isArray(k) ? k[0] : k).filter(Boolean);
    if (forms.length > 0) {
      sql += ` AND r.form = ANY($2)`;
      params.push(forms);
    }
  }

  sql += ` ORDER BY r.form ASC, r.reported_date ASC`;
  sql = addPagination(sql, limit, skip);

  return { sql, params };
};

const getKey = (row) => [row.form];

const getValue = (row) => row.reported_date;

// reports_by_form view
// Key: [form]
// Value: reported_date
const reports_by_form = async (userCtx, query) => {
  return executeView(userCtx, query, buildQuery, getKey, getValue);
};

module.exports = reports_by_form;
