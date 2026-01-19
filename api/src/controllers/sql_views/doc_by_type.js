const { addPagination, executeView, postgres } = require('./utils');

const buildQuery = (userContactId, keys, include_docs, limit, skip) => {
  let sql = `
    SELECT
      d._id as id,
      d.type
      ${include_docs ? ', d.doc' : ''}
    FROM medic_documents d
    WHERE d.type IS NOT NULL
  `;

  const params = [];

  if (keys && keys.length > 0) {
    const types = keys.map(k => Array.isArray(k) ? k[0] : k).filter(Boolean);
    if (types.length > 0) {
      sql += ` AND d.type = ANY($1)`;
      params.push(types);
    }
  }

  sql += ` ORDER BY d.type ASC`;
  sql = addPagination(sql, limit, skip);

  return { sql, params };
};

const getKey = (row) => [row.type];

const getValue = (row) => null;

// doc_by_type view
// Key: [type]
// Value: null
// Note: This view does not apply authorization - it returns all documents by type
const doc_by_type = async (userCtx, query) => {
  return executeView(userCtx, query, buildQuery, getKey, getValue);
};

module.exports = doc_by_type;
