const { addPagination, executeView, postgres } = require('./utils');

const buildQuery = (userContactId, keys, include_docs, limit, skip) => {
  // Messages are data_records without a form
  // Need to extract contact from different places for incoming vs outgoing
  let sql = `
    SELECT
      r.id,
      d.doc,
      r.reported_date,
      CASE
        WHEN d.doc->>'sms_message' IS NOT NULL THEN
          COALESCE(d.doc->'contact'->>'_id', d.doc->>'from', r.id)
        WHEN d.doc->>'kujua_message' IS NOT NULL THEN
          COALESCE(
            d.doc->'tasks'->0->'messages'->0->'contact'->>'_id',
            d.doc->'tasks'->0->'messages'->0->>'to',
            r.id
          )
        ELSE r.id
      END as contact_key
    FROM reports r
    INNER JOIN medic_documents d ON d._id = r.id
    WHERE r.form IS NULL
  `;

  const params = [];

  if (keys && keys.length > 0) {
    // Keys are [contact_id, date] arrays
    const contactIds = keys.map(k => Array.isArray(k) ? k[0] : k).filter(Boolean);
    if (contactIds.length > 0) {
      sql += ` AND CASE
        WHEN d.doc->>'sms_message' IS NOT NULL THEN
          COALESCE(d.doc->'contact'->>'_id', d.doc->>'from', r.id)
        WHEN d.doc->>'kujua_message' IS NOT NULL THEN
          COALESCE(
            d.doc->'tasks'->0->'messages'->0->'contact'->>'_id',
            d.doc->'tasks'->0->'messages'->0->>'to',
            r.id
          )
        ELSE r.id
      END = ANY($1)`;
      params.push(contactIds);
    }
  }

  sql += ` ORDER BY contact_key ASC, r.reported_date ASC`;
  sql = addPagination(sql, limit, skip);

  return { sql, params };
};

const getKey = (row) => [row.contact_key, row.reported_date];

const getValue = (row) => {
  // Extract contact._id from doc
  let contactId = null;
  if (row.doc.sms_message) {
    contactId = row.doc.contact?._id;
  } else if (row.doc.kujua_message && row.doc.tasks && row.doc.tasks[0]) {
    const message = row.doc.tasks[0].messages?.[0];
    contactId = message?.contact?._id;
  }

  return {
    id: row.id,
    date: row.reported_date,
    contact: contactId
  };
};

// messages_by_contact_date view
// Key: [contact_id, reported_date]
// Value: {id, date, contact}
// Only for data_records without form (messages)
const messages_by_contact_date = async (userCtx, query) => {
  return executeView(userCtx, query, buildQuery, getKey, getValue);
};

module.exports = messages_by_contact_date;
