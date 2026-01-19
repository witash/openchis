const { addPagination, executeView, postgres } = require('./utils');

const buildQuery = (userContactId, keys, include_docs, limit, skip) => {
  let sql = `
    SELECT
      c.id,
      lineage_ids.id as place_id,
      c.contact_type,
      c.name
      ${include_docs ? ', d.doc' : ''}
    FROM contacts c
    ${include_docs ? 'INNER JOIN medic_documents d ON d._id = c.id' : ''}
    CROSS JOIN unnest(c.lineage) AS lineage_ids(id)
    WHERE c.contact_type IS NOT NULL
      AND (c.lineage @> ARRAY[$1] OR c.id = $1)
  `;

  const params = [userContactId];

  if (keys && keys.length > 0) {
    const placeIds = keys.map(k => Array.isArray(k) ? k[0] : k).filter(Boolean);
    if (placeIds.length > 0) {
      sql += ` AND lineage_ids.id = ANY($2)`;
      params.push(placeIds);
    }
  }

  sql += ` ORDER BY place_id ASC, contact_type ASC, LOWER(COALESCE(c.name, '')) ASC`;
  sql = addPagination(sql, limit, skip);

  return { sql, params };
};

const getKey = (row) => [row.place_id];

const getValue = (row) => {
  const types = ['district_hospital', 'health_center', 'clinic', 'person'];
  let idx = types.indexOf(row.contact_type);
  if (idx === -1) {
    idx = row.contact_type;
  }
  return `${idx} ${(row.name || '').toLowerCase()}`;
};

// contacts_by_place view
// Key: [place_id]
// Value: ordering string (type_idx + name)
// Emits for each ancestor in the contact's lineage
const contacts_by_place = async (userCtx, query) => {
  return executeView(userCtx, query, buildQuery, getKey, getValue);
};

module.exports = contacts_by_place;
