const { parseQueryParams, formatResponse, getUserContactId, postgres } = require('./utils');

const buildQuery = (userContactId, keys, include_docs, limit, skip) => {
  // This view emits registration reports (data_records with forms, no errors)
  // Emits once for patient_id and once for place_id if they exist
  // Key: patient_id or place_id (as string)
  // Value: null (no value in original view)

  let sql = `
    SELECT
      r.id,
      d.doc->>'patient_id' as doc_patient_id,
      d.doc->'fields'->>'patient_id' as fields_patient_id,
      d.doc->>'place_id' as doc_place_id,
      d.doc->'fields'->>'place_id' as fields_place_id
      ${include_docs ? ', d.doc' : ''}
    FROM reports r
    INNER JOIN medic_documents d ON d._id = r.id
    INNER JOIN contacts c ON r.contact = c.id
    WHERE r.form IS NOT NULL
      AND r.type = 'data_record'
      AND (r.has_errors = FALSE OR r.has_errors IS NULL)
      AND (c.lineage @> ARRAY[$1] OR c.id = $1)
  `;

  const params = [userContactId];

  if (keys && keys.length > 0) {
    // Filter by patient_id or place_id
    sql += ` AND (
      COALESCE(d.doc->>'patient_id', d.doc->'fields'->>'patient_id') = ANY($2)
      OR COALESCE(d.doc->>'place_id', d.doc->'fields'->>'place_id') = ANY($2)
    )`;
    params.push(keys);
  }

  sql += ` ORDER BY r.id ASC`;

  if (limit) {
    sql += ` LIMIT ${parseInt(limit)}`;
  }
  if (skip) {
    sql += ` OFFSET ${parseInt(skip)}`;
  }

  return { sql, params };
};

const formatRows = (dbRows, include_docs) => {
  // Each report can emit up to twice: once for patient_id, once for place_id
  const rows = [];

  dbRows.forEach(r => {
    const patientId = r.doc_patient_id || r.fields_patient_id;
    const placeId = r.doc_place_id || r.fields_place_id;

    if (patientId) {
      rows.push({
        id: r.id,
        key: String(patientId),
        value: null,
        doc: include_docs ? r.doc : undefined
      });
    }

    if (placeId) {
      rows.push({
        id: r.id,
        key: String(placeId),
        value: null,
        doc: include_docs ? r.doc : undefined
      });
    }
  });

  return rows;
};

// registered_patients view
// Returns registration reports for contacts
// Key: patient_id or place_id (as string)
// Value: null
// Note: Only returns contacts created via registration reports, not UI-created contacts
const registered_patients = async (userCtx, query) => {
  const { keys, include_docs, limit, skip } = parseQueryParams(query);
  const userContactId = getUserContactId(userCtx);

  const { sql, params } = buildQuery(userContactId, keys, include_docs, limit, skip);
  const result = await postgres.pool.query(sql, params);
  const rows = formatRows(result.rows, include_docs);

  return formatResponse(rows, query);
};

module.exports = registered_patients;
