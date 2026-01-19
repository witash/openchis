const { parseQueryParams, addPagination, formatResponse, getUserContactId, postgres } = require('./utils');

const buildQuery = (userContactId, keys, include_docs, limit, skip) => {
  // This view UNIONs contacts with reports
  // Contacts emit with key=id, value=0
  // Reports emit with key=visited_contact_uuid, value=visited_date

  let contactsSql = `
    SELECT
      c.id,
      c.id as key_id,
      0 as visit_date,
      'contact' as source
      ${include_docs ? ', d.doc' : ''}
    FROM contacts c
    ${include_docs ? 'INNER JOIN medic_documents d ON d._id = c.id' : ''}
    WHERE (c.lineage @> ARRAY[$1] OR c.id = $1)
  `;

  let reportsSql = `
    SELECT
      r.id,
      r.visited_contact_uuid as key_id,
      COALESCE(r.visited_date, r.reported_date) as visit_date,
      'report' as source
      ${include_docs ? ', d.doc' : ''}
    FROM reports r
    ${include_docs ? 'INNER JOIN medic_documents d ON d._id = r.id' : ''}
    INNER JOIN contacts c ON r.subject = c.id
    WHERE r.visited_contact_uuid IS NOT NULL
      AND (c.lineage @> ARRAY[$1] OR c.id = $1)
  `;

  const params = [userContactId];

  if (keys && keys.length > 0) {
    const contactIds = keys.map(k => k).filter(Boolean);
    if (contactIds.length > 0) {
      contactsSql += ` AND c.id = ANY($2)`;
      reportsSql += ` AND r.visited_contact_uuid = ANY($2)`;
      params.push(contactIds);
    }
  }

  let sql = `
    SELECT * FROM (
      ${contactsSql}
      UNION ALL
      ${reportsSql}
    ) combined
    ORDER BY key_id ASC, visit_date DESC
  `;

  sql = addPagination(sql, limit, skip);

  return { sql, params };
};

const formatRows = (dbRows, include_docs) => {
  return dbRows.map(r => {
    const row = {
      id: r.id,
      key: r.key_id,
      value: r.visit_date
    };

    if (include_docs && r.doc) {
      row.doc = r.doc;
    }

    return row;
  });
};

// contacts_by_last_visited view
// Key: contact_id
// Value: 0 for contacts, visited_date for reports
const contacts_by_last_visited = async (userCtx, query) => {
  const { keys, include_docs, limit, skip } = parseQueryParams(query);
  const userContactId = getUserContactId(userCtx);

  const { sql, params } = buildQuery(userContactId, keys, include_docs, limit, skip);
  const result = await postgres.pool.query(sql, params);
  const rows = formatRows(result.rows, include_docs);

  return formatResponse(rows, query);
};

module.exports = contacts_by_last_visited;
