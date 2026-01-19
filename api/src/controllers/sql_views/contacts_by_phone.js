const { addPagination, executeView, postgres } = require('./utils');

const buildQuery = (userContactId, keys, include_docs, limit, skip) => {
  let sql = `
    SELECT
      c.id,
      c.phone
      ${include_docs ? ', d.doc' : ''}
    FROM contacts c
    ${include_docs ? 'INNER JOIN medic_documents d ON d._id = c.id' : ''}
    WHERE c.phone IS NOT NULL
      AND c.phone = ANY($2)
      AND (c.lineage @> ARRAY[$1] OR c.id = $1)
    ORDER BY c.phone ASC
  `;

  const phones = keys.map(k => k).filter(Boolean);
  const params = [userContactId, phones];

  sql = addPagination(sql, limit, skip);

  return { sql, params };
};

const getKey = (row) => row.phone;

const getValue = (row) => null;

// contacts_by_phone view
// Key: phone
// Value: null
const contacts_by_phone = async (userCtx, query) => {
  return executeView(userCtx, query, buildQuery, getKey, getValue, { requireKeys: true });
};

module.exports = contacts_by_phone;
