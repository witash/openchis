const transform = require('./transform');

const SELECT_PROGRESS = 'SELECT seq FROM couch2pg_progress WHERE source = $1';
const UPSERT_PROGRESS = `
  INSERT INTO couch2pg_progress (source, seq, updated_at)
  VALUES ($1, $2, NOW())
  ON CONFLICT (source) DO UPDATE SET
    seq = EXCLUDED.seq,
    updated_at = NOW()
`;

const INSERT_DOC = `
  INSERT INTO medic_documents
    (_id, _rev, couchdb_seq, doc, subject, type, deleted)
  VALUES
    ($1, $2, $3, $4, $5, $6, $7)
  ON CONFLICT (_id, _rev) DO UPDATE SET
    couchdb_seq = EXCLUDED.couchdb_seq,
    doc = EXCLUDED.doc,
    subject = EXCLUDED.subject,
    type = EXCLUDED.type,
    deleted = EXCLUDED.deleted
`;

const UPDATE_DOC_SUBJECT_BY_ID = `
  UPDATE medic_documents
  SET subject = $1
  WHERE _id = $2
`;

const SELECT_CONTACT = 'SELECT id, parent, lineage FROM contacts WHERE id = $1';
const SELECT_DESCENDANTS = 'SELECT id, lineage FROM contacts WHERE $1 = ANY(lineage)';
const UPSERT_CONTACT = `
  INSERT INTO contacts
    (id, type, contact_type, parent, lineage, name, muted, phone, shortcode)
  VALUES
    ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
const UPDATE_CONTACT_LINEAGE = 'UPDATE contacts SET lineage = $1 WHERE id = $2';
const DELETE_CONTACT = 'DELETE FROM contacts WHERE id = $1';

// Postgres rejects U+0000 inside JSONB; strip both escaped and literal forms.
// Built via RegExp constructor to avoid embedding a literal NUL in source.
const NULL_BYTE_PATTERN = new RegExp('(\\\\+u0000)|' + String.fromCharCode(0), 'g');
const sanitize = (text) => text && text.replace(NULL_BYTE_PATTERN, '');

const arraysEqual = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b)) {
    return false;
  }
  if (a.length !== b.length) {
    return false;
  }
  return a.every((value, index) => value === b[index]);
};

const isMalformed = (change) => {
  if (!change || typeof change !== 'object') {
    return true;
  }
  if (!change.id || typeof change.id !== 'string') {
    return true;
  }
  if (change.deleted) {
    return false;
  }
  if (!change.doc || typeof change.doc !== 'object') {
    return true;
  }
  if (!change.doc._id || !change.doc._rev) {
    return true;
  }
  return false;
};

const getProgress = async (client, source) => {
  const result = await client.query(SELECT_PROGRESS, [source]);
  if (!result || !result.rows || !result.rows.length) {
    return 0;
  }
  return result.rows[0].seq;
};

const saveProgress = async (client, source, seq) => {
  const value = seq === undefined || seq === null ? '0' : String(seq);
  await client.query(UPSERT_PROGRESS, [source, value]);
};

const lookupContact = async (client, id) => {
  if (!id) {
    return null;
  }
  const result = await client.query(SELECT_CONTACT, [id]);
  if (!result || !result.rows || !result.rows.length) {
    return null;
  }
  return result.rows[0];
};

const computeLineageForParent = async (client, parentId) => {
  if (!parentId) {
    return [];
  }
  const parent = await lookupContact(client, parentId);
  // If the parent isn't known yet, fall back to a minimal lineage of just the
  // parent id. A later parent change will repair this once the parent arrives.
  if (!parent) {
    return [parentId];
  }
  return [parentId, ...(parent.lineage || [])];
};

const cascadeLineage = async (client, contactId, newContactLineage) => {
  const result = await client.query(SELECT_DESCENDANTS, [contactId]);
  const rows = (result && result.rows) || [];
  for (const row of rows) {
    const oldLineage = row.lineage || [];
    const pivot = oldLineage.indexOf(contactId);
    if (pivot === -1) {
      continue;
    }
    const prefix = oldLineage.slice(0, pivot);
    const newDescLineage = [...prefix, contactId, ...newContactLineage];
    if (!arraysEqual(oldLineage, newDescLineage)) {
      await client.query(UPDATE_CONTACT_LINEAGE, [newDescLineage, row.id]);
    }
  }
};

const insertDocRow = async (client, change) => {
  if (change.deleted) {
    const rev = (change.changes && change.changes[0] && change.changes[0].rev) ||
      (change.doc && change.doc._rev) ||
      '';
    const tombstone = { _id: change.id, _rev: rev, _deleted: true };
    await client.query(INSERT_DOC, [
      change.id,
      rev || '0',
      change.seq ? String(change.seq) : null,
      JSON.stringify(tombstone),
      null,
      null,
      true,
    ]);
    return;
  }

  const doc = change.doc;
  const docType = transform.getDocType(doc);
  const subject = transform.getSubject(doc);
  await client.query(INSERT_DOC, [
    doc._id,
    doc._rev,
    change.seq ? String(change.seq) : null,
    sanitize(JSON.stringify(doc)),
    subject,
    docType,
    false,
  ]);
};

const upsertContactRow = async (client, doc, lineage) => {
  await client.query(UPSERT_CONTACT, [
    doc._id,
    doc.type || null,
    transform.getContactType(doc),
    transform.getParentId(doc),
    lineage,
    typeof doc.name === 'string' ? doc.name : null,
    doc.muted ? new Date(doc.muted) : null,
    typeof doc.phone === 'string' ? doc.phone : null,
    typeof doc.shortcode === 'string' ? doc.shortcode : null,
  ]);
};

const processChange = async (client, change) => {
  if (isMalformed(change)) {
    return { skipped: true, reason: 'malformed' };
  }

  await insertDocRow(client, change);

  if (change.deleted) {
    await client.query(DELETE_CONTACT, [change.id]);
    return { ok: true };
  }

  const doc = change.doc;
  if (!transform.isContactDoc(doc)) {
    return { ok: true };
  }

  const parentId = transform.getParentId(doc);
  const newLineage = await computeLineageForParent(client, parentId);

  const previous = await lookupContact(client, doc._id);

  await upsertContactRow(client, doc, newLineage);

  if (previous && !arraysEqual(previous.lineage || [], newLineage)) {
    await cascadeLineage(client, doc._id, newLineage);
    // The contact's subject (its own id) hasn't changed, but re-stamp it on
    // medic_documents rows referencing this contact to handle the edge case
    // where prior writes landed with subject = null.
    await client.query(UPDATE_DOC_SUBJECT_BY_ID, [doc._id, doc._id]);
  }

  return { ok: true };
};

const processBatch = async (pool, source, batch) => {
  const changes = (batch && batch.results) || [];
  const lastSeq = batch && batch.last_seq;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const results = [];
    for (const change of changes) {
      results.push(await processChange(client, change));
    }
    if (lastSeq !== undefined && lastSeq !== null) {
      await saveProgress(client, source, lastSeq);
    }
    await client.query('COMMIT');
    return { processed: changes.length, results, last_seq: lastSeq };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_rollbackErr) {
      // ignore — propagate the original error
    }
    throw err;
  } finally {
    client.release();
  }
};

module.exports = {
  processBatch,
  processChange,
  getProgress,
  saveProgress,
  computeLineageForParent,
  cascadeLineage,
  isMalformed,
  sanitize,
  _sql: {
    SELECT_PROGRESS,
    UPSERT_PROGRESS,
    INSERT_DOC,
    SELECT_CONTACT,
    SELECT_DESCENDANTS,
    UPSERT_CONTACT,
    UPDATE_CONTACT_LINEAGE,
    DELETE_CONTACT,
    UPDATE_DOC_SUBJECT_BY_ID,
  },
};
