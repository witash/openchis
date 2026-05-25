// Bulk insert helpers for the pg-sync mirror.
//
// `documents` uses ON CONFLICT (_id, _rev) DO NOTHING. The PK ensures
// idempotency for retried writes of the same revision.
//
// `contacts`, `reports`, and `tasks` keep UPSERT semantics so later
// revisions of the same doc replace the extracted columns.

const DOCUMENT_COLUMNS = 6;
const CONTACT_COLUMNS = 9;
const REPORT_COLUMNS = 5;
const TASK_COLUMNS = 4;

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

const insertDocumentsSQL = (rowCount) => `
  INSERT INTO documents
    (_id, _rev, doc, subject, type, deleted)
  VALUES
    ${buildPlaceholders(rowCount, DOCUMENT_COLUMNS)}
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

const upsertReportsSQL = (rowCount) => `
  INSERT INTO reports
    (id, subject, contact, form, reported_date)
  VALUES
    ${buildPlaceholders(rowCount, REPORT_COLUMNS)}
  ON CONFLICT (id) DO UPDATE SET
    subject = EXCLUDED.subject,
    contact = EXCLUDED.contact,
    form = EXCLUDED.form,
    reported_date = EXCLUDED.reported_date
`;

const upsertTasksSQL = (rowCount) => `
  INSERT INTO tasks
    (id, owner, requester, state)
  VALUES
    ${buildPlaceholders(rowCount, TASK_COLUMNS)}
  ON CONFLICT (id) DO UPDATE SET
    owner = EXCLUDED.owner,
    requester = EXCLUDED.requester,
    state = EXCLUDED.state
`;

// Postgres rejects U+0000 inside JSONB; strip both escaped and literal forms.
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

const write = async (records, pgClient) => {
  const list = normalizeRecords(records);
  if (!list.length) {
    return;
  }

  const documents = list.map(r => r && r.document).filter(Boolean);
  if (documents.length) {
    const params = [];
    for (const d of documents) {
      params.push(
        d._id,
        d._rev,
        serializeDoc(d.doc),
        d.subject === undefined ? null : d.subject,
        d.type === undefined ? null : d.type,
        d.deleted === true,
      );
    }
    await pgClient.query(insertDocumentsSQL(documents.length), params);
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

  const reports = list.map(r => r && r.report).filter(Boolean);
  if (reports.length) {
    const params = [];
    for (const r of reports) {
      params.push(
        r.id,
        r.subject === undefined ? null : r.subject,
        r.contact === undefined ? null : r.contact,
        r.form === undefined ? null : r.form,
        r.reported_date === undefined ? null : r.reported_date,
      );
    }
    await pgClient.query(upsertReportsSQL(reports.length), params);
  }

  const tasks = list.map(r => r && r.task).filter(Boolean);
  if (tasks.length) {
    const params = [];
    for (const t of tasks) {
      params.push(
        t.id,
        t.owner === undefined ? null : t.owner,
        t.requester === undefined ? null : t.requester,
        t.state === undefined ? null : t.state,
      );
    }
    await pgClient.query(upsertTasksSQL(tasks.length), params);
  }
};

module.exports = {
  write,
  sanitize,
  _sql: {
    insertDocumentsSQL,
    upsertContactsSQL,
    upsertReportsSQL,
    upsertTasksSQL,
  },
};
