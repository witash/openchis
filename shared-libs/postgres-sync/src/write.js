// Bulk insert helpers for the pg-sync mirror.
//
// `medic_documents` uses ON CONFLICT (_id, _rev) DO NOTHING. The PK ensures
// that two writers racing on the same revision (eg. api interceptor and the
// sentinel changes-feed mirror) both compute identical row contents — DO
// NOTHING keeps whichever landed first.
//
// `contacts` keeps the existing UPSERT semantics: the contact row may need to
// be updated (eg. when the same contact reparents and lineage changes).
// Cascading lineage updates to descendants is the caller's responsibility —
// the sentinel mirror still owns that step.

const MEDIC_DOC_COLUMNS = 7;
const CONTACT_COLUMNS = 9;

const buildPlaceholders = (rowCount, columnCount) => {
  const rows = [];
  for (let i = 0; i < rowCount; i++) {
    const base = i * columnCount;
    const cols = [];
    for (let c = 1; c <= columnCount; c++) {
      cols.push(`$${base + c}`);
    }
    rows.push(`(${cols.join(', ')})`);
  }
  return rows.join(', ');
};

const insertMedicDocumentsSQL = (rowCount) => `
  INSERT INTO medic_documents
    (_id, _rev, couchdb_seq, doc, subject, type, deleted)
  VALUES
    ${buildPlaceholders(rowCount, MEDIC_DOC_COLUMNS)}
  ON CONFLICT (_id, _rev) DO NOTHING
`;

const upsertContactsSQL = (rowCount) => `
  INSERT INTO contacts
    (id, type, contact_type, parent, lineage, name, muted, phone, shortcode)
  VALUES
    ${buildPlaceholders(rowCount, CONTACT_COLUMNS)}
  ON CONFLICT (id) DO UPDATE SET
    type = EXCLUDED.type,
    contact_type = EXCLUDED.contact_type,
    parent = EXCLUDED.parent,
    lineage = EXCLUDED.lineage,
    name = EXCLUDED.name,
    muted = EXCLUDED.muted,
    phone = EXCLUDED.phone,
    shortcode = EXCLUDED.shortcode
`;

// Postgres rejects U+0000 inside JSONB; strip both escaped and literal forms.
// Built via RegExp constructor to avoid embedding a literal NUL in source.
const NULL_BYTE_PATTERN = new RegExp('(\\\\+u0000)|' + String.fromCharCode(0), 'g');
const sanitize = (text) => (text === undefined || text === null) ? text : text.replace(NULL_BYTE_PATTERN, '');

const serializeDoc = (doc) => {
  if (typeof doc === 'string') {
    return sanitize(doc);
  }
  return sanitize(JSON.stringify(doc));
};

const normalizeRecords = (records) => {
  if (!records) {
    return [];
  }
  if (Array.isArray(records)) {
    return records.filter(Boolean);
  }
  return [records];
};

// Writes a batch of records produced by `transform()` to Postgres.
// One bulk INSERT per table, sequential (medic_documents first, then contacts).
// The pgClient is the caller's transaction context; this function does not
// open or close a transaction.
const write = async (records, pgClient) => {
  const list = normalizeRecords(records);
  if (!list.length) {
    return;
  }

  const medicDocs = list.map(r => r && r.medicDocument).filter(Boolean);
  if (medicDocs.length) {
    const params = [];
    for (const md of medicDocs) {
      params.push(
        md._id,
        md._rev,
        md.couchdb_seq === undefined ? null : md.couchdb_seq,
        serializeDoc(md.doc),
        md.subject === undefined ? null : md.subject,
        md.type === undefined ? null : md.type,
        md.deleted === true,
      );
    }
    await pgClient.query(insertMedicDocumentsSQL(medicDocs.length), params);
  }

  const contacts = list.map(r => r && r.contact).filter(Boolean);
  if (contacts.length) {
    const params = [];
    for (const c of contacts) {
      params.push(
        c.id,
        c.type || null,
        c.contact_type === undefined ? null : c.contact_type,
        c.parent === undefined ? null : c.parent,
        c.lineage || [],
        c.name === undefined ? null : c.name,
        c.muted === undefined ? null : c.muted,
        c.phone === undefined ? null : c.phone,
        c.shortcode === undefined ? null : c.shortcode,
      );
    }
    await pgClient.query(upsertContactsSQL(contacts.length), params);
  }
};

module.exports = {
  write,
  sanitize,
  _sql: {
    insertMedicDocumentsSQL,
    upsertContactsSQL,
  },
};
