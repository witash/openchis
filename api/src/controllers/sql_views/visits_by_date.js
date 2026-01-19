const { parseQueryParams, addPagination, formatResponse, getUserContactId, postgres } = require('./utils');

const buildQuery = (userContactId, keys, include_docs, limit, skip) => {
  // This view emits twice per report:
  // 1. key=visited_date, value=visited_contact_uuid
  // 2. key=[visited_contact_uuid, visited_date], value=null

  let sql = `
    SELECT
      r.id,
      r.visited_contact_uuid,
      COALESCE(r.visited_date, r.reported_date) as visit_date
      ${include_docs ? ', d.doc' : ''}
    FROM reports r
    ${include_docs ? 'INNER JOIN medic_documents d ON d._id = r.id' : ''}
    INNER JOIN contacts c ON r.subject = c.id
    WHERE r.visited_contact_uuid IS NOT NULL
      AND (c.lineage @> ARRAY[$1] OR c.id = $1)
  `;

  const params = [userContactId];

  // Note: CouchDB emits twice but with different keys
  // For simplicity, we'll return rows that can be transformed in formatRows

  sql += ` ORDER BY visit_date ASC`;
  sql = addPagination(sql, limit, skip);

  return { sql, params };
};

const formatRows = (dbRows, include_docs) => {
  // Each report generates two rows in CouchDB
  const rows = [];

  dbRows.forEach(r => {
    // First emission: key=visited_date, value=visited_contact_uuid
    rows.push({
      id: r.id,
      key: r.visit_date,
      value: r.visited_contact_uuid,
      doc: include_docs ? r.doc : undefined
    });

    // Second emission: key=[visited_contact_uuid, visited_date], value=null
    rows.push({
      id: r.id,
      key: [r.visited_contact_uuid, r.visit_date],
      value: null,
      doc: include_docs ? r.doc : undefined
    });
  });

  return rows;
};

// visits_by_date view
// Emits twice per report:
// - Key: visited_date, Value: visited_contact_uuid
// - Key: [visited_contact_uuid, visited_date], Value: null
const visits_by_date = async (userCtx, query) => {
  const { keys, include_docs, limit, skip } = parseQueryParams(query);
  const userContactId = getUserContactId(userCtx);

  const { sql, params } = buildQuery(userContactId, keys, include_docs, limit, skip);
  const result = await postgres.pool.query(sql, params);
  const rows = formatRows(result.rows, include_docs);

  return formatResponse(rows, query);
};

module.exports = visits_by_date;
