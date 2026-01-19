const { parseQueryParams, formatResponse, getUserContactId, postgres } = require('./utils');

const CONTACT_TYPES = ['contact', 'district_hospital', 'health_center', 'clinic', 'person'];

const getDocument = async (docId) => {
  const sql = `SELECT _id, doc FROM medic_documents WHERE _id = $1`;
  const result = await postgres.pool.query(sql, [docId]);
  return result.rows.length > 0 ? result.rows[0].doc : null;
};

const getContact = async (doc) => {
  const contactId = typeof doc.contact === 'string' ? doc.contact : doc.contact?._id;
  if (!contactId) {
    return null;
  }

  const sql = `SELECT lineage FROM contacts WHERE id = $1`;
  const result = await postgres.pool.query(sql, [contactId]);
  return result.rows.length > 0 ? result.rows[0] : null;
};

const getLineage = async (docId, userContactId) => {
  const sql = `
    SELECT lineage
    FROM contacts
    WHERE id = $1
      AND (lineage @> ARRAY[$2] OR id = $2)
  `;
  const result = await postgres.pool.query(sql, [docId, userContactId]);
  return result.rows.length > 0 ? result.rows[0].lineage : null;
};

const formatResults = (docId, doc, lineage, isContact, depth, include_docs, skip, limit) => {
  const rows = [];

  // Emit the document itself at depth 0
  if (depth === undefined || depth === 0) {
    const row = {
      id: docId,
      key: [docId, 0],
      value: isContact ? { _id: docId } : null
    };
    if (include_docs) row.doc = doc;
    rows.push(row);
  }

  // Emit ancestors from lineage (depth starts at 1 for both contacts and reports)
  lineage.forEach((ancestorId, idx) => {
    const ancestorDepth = idx + 1;
    if (depth === undefined || depth === ancestorDepth) {
      const row = {
        id: docId,
        key: [docId, ancestorDepth],
        value: { _id: ancestorId }
      };
      if (include_docs) row.doc = doc;
      rows.push(row);
    }
  });

  return rows;
};

// docs_by_id_lineage view
// Key: [doc_id, depth]
// Value: {_id: lineage_id} or null for reports at depth 0
const docs_by_id_lineage = async (userCtx, query) => {
  const { startkey, include_docs, limit, skip } = parseQueryParams(query);
  const userContactId = getUserContactId(userCtx);

  // Extract doc_id and depth from startkey
  if (!startkey || !Array.isArray(startkey) || !startkey[0]) {
    return formatResponse([], query);
  }

  const docId = startkey[0];
  const depth = startkey[1]; // Can be undefined if querying all depths

  // Get the document
  const doc = await getDocument(docId);
  if (!doc) {
    return formatResponse([], query);
  }

  const isContact = CONTACT_TYPES.includes(doc.type);
  const isReport = doc.type === 'data_record' && doc.form;

  if (!isContact && !isReport) {
    return formatResponse([], query);
  }

  // Get lineage
  let lineage;
  if (isReport) {
    const contact = await getContact(doc);
    if (!contact) {
      return formatResponse([], query);
    }
    lineage = contact.lineage || [];
  } else {
    lineage = await getLineage(docId, userContactId);
    if (lineage === null) {
      return formatResponse([], query);
    }
  }

  const rows = formatResults(docId, doc, lineage, isContact, depth, include_docs, skip, limit);
  return formatResponse(rows, query);
};

module.exports = docs_by_id_lineage;
