const { addPagination, executeView, postgres } = require('./utils');

const buildQuery = (userContactId, keys, include_docs, limit, skip) => {
  let sql = `
    SELECT
      c.id,
      c.contact_type,
      d.doc->>'date_of_death' as date_of_death,
      c.muted,
      c.name
      ${include_docs ? ', d.doc' : ''}
    FROM contacts c
    INNER JOIN medic_documents d ON d._id = c.id
    WHERE c.contact_type = ANY($2)
      AND (c.lineage @> ARRAY[$1] OR c.id = $1)
    ORDER BY
      c.contact_type ASC,
      (COALESCE(d.doc->>'date_of_death', '') <> '') ASC,
      (c.muted IS NOT NULL) ASC,
      LOWER(COALESCE(c.name, '')) ASC
  `;

  const types = keys.map(k => Array.isArray(k) ? k[0] : k).filter(Boolean);
  const params = [userContactId, types];

  sql = addPagination(sql, limit, skip);

  return { sql, params };
};

const getKey = (row) => [row.contact_type];

const getValue = (row) => {
  const dead = !!row.date_of_death;
  const muted = !!row.muted;
  return `${dead} ${muted} ${(row.name || '').toLowerCase()}`;
};

// contacts_by_type view
// Key: [contact_type]
// Value: ordering string (dead, muted, name)
const contacts_by_type = async (userCtx, query) => {
  return executeView(userCtx, query, buildQuery, getKey, getValue);
};

module.exports = contacts_by_type;
