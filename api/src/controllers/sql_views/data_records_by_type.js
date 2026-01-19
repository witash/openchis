const { parseQueryParams, addPagination, formatResponse, getUserContactId, postgres } = require('./utils');

const buildQuery = (userContactId, keys, include_docs, reduce, limit, skip) => {
  if (reduce) {
    // Reduce query: count by type (report vs message)
    let sql = `
      SELECT
        CASE WHEN r.form IS NOT NULL THEN 'report' ELSE 'message' END as record_type,
        COUNT(*) as count
      FROM reports r
      INNER JOIN contacts c ON r.subject = c.id
      WHERE (c.lineage @> ARRAY[$1] OR c.id = $1)
    `;

    const params = [userContactId];

    if (keys && keys.length > 0) {
      const types = keys.map(k => k);
      if (types.length === 1) {
        if (types[0] === 'report') {
          sql += ` AND r.form IS NOT NULL`;
        } else if (types[0] === 'message') {
          sql += ` AND r.form IS NULL`;
        }
      }
    }

    sql += ` GROUP BY record_type`;

    return { sql, params };
  } else {
    // Map query: return individual records
    let sql = `
      SELECT
        r.id,
        CASE WHEN r.form IS NOT NULL THEN 'report' ELSE 'message' END as record_type
        ${include_docs ? ', d.doc' : ''}
      FROM reports r
      ${include_docs ? 'INNER JOIN medic_documents d ON d._id = r.id' : ''}
      INNER JOIN contacts c ON r.subject = c.id
      WHERE (c.lineage @> ARRAY[$1] OR c.id = $1)
    `;

    const params = [userContactId];

    if (keys && keys.length > 0) {
      const types = keys.map(k => k);
      if (types.length === 1) {
        if (types[0] === 'report') {
          sql += ` AND r.form IS NOT NULL`;
        } else if (types[0] === 'message') {
          sql += ` AND r.form IS NULL`;
        }
      }
    }

    sql += ` ORDER BY record_type ASC`;
    sql = addPagination(sql, limit, skip);

    return { sql, params };
  }
};

const formatRows = (dbRows, include_docs) => {
  return dbRows.map(r => {
    const row = {
      id: r.id,
      key: r.record_type,
      value: null
    };

    if (include_docs && r.doc) {
      row.doc = r.doc;
    }

    return row;
  });
};

const formatReduceRows = (dbRows) => {
  return dbRows.map(r => ({
    key: r.record_type,
    value: parseInt(r.count)
  }));
};

// data_records_by_type view
// Key: 'report' or 'message'
// Value: null (map) or count (reduce)
const data_records_by_type = async (userCtx, query) => {
  const params = parseQueryParams(query);
  const { keys, include_docs, limit, skip } = params;
  const reduce = query.reduce !== 'false' && query.reduce !== false;
  const userContactId = getUserContactId(userCtx);

  const { sql, params: sqlParams } = buildQuery(userContactId, keys, include_docs, reduce, limit, skip);
  const result = await postgres.pool.query(sql, sqlParams);

  let rows;
  if (reduce) {
    rows = formatReduceRows(result.rows);
  } else {
    rows = formatRows(result.rows, include_docs);
  }

  return formatResponse(rows, query);
};

module.exports = data_records_by_type;
