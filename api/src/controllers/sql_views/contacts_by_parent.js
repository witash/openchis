const { addPagination, executeView, postgres } = require('./utils');

const buildQuery = (userContactId, keys, include_docs, limit, skip) => {
  let sql = `
    SELECT
      c.id,
      c.parent,
      c.contact_type
      ${include_docs ? ', d.doc' : ''}
    FROM contacts c
    ${include_docs ? 'INNER JOIN medic_documents d ON d._id = c.id' : ''}
    WHERE c.parent = ANY($2)
      AND (c.lineage @> ARRAY[$1] OR c.id = $1)
    ORDER BY c.parent ASC, c.contact_type ASC
  `;

  const parents = keys.map(k => Array.isArray(k) ? k[0] : k).filter(Boolean);
  const params = [userContactId, parents];

  sql = addPagination(sql, limit, skip);

  return { sql, params };
};

const getKey = (row) => [row.parent, row.contact_type];

const getValue = (row) => null;

// contacts_by_parent view
// Key: [parent_id, contact_type]
// Value: null
const contacts_by_parent = async (userCtx, query) => {
  return executeView(userCtx, query, buildQuery, getKey, getValue, { requireKeys: true });
};

module.exports = contacts_by_parent;
