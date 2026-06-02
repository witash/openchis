const pgSync = require('@medic/postgres-sync');

const SELECT_PROGRESS = 'SELECT seq FROM couch2pg_progress WHERE source = $1';
const UPSERT_PROGRESS = `
  INSERT INTO couch2pg_progress (source, seq, updated_at)
  VALUES ($1, $2, NOW())
  ON CONFLICT (source) DO UPDATE SET
    seq = EXCLUDED.seq,
    updated_at = NOW()
`;

const UPDATE_DOC_SUBJECT_BY_ID = `
  UPDATE documents
  SET subject = $1
  WHERE _id = $2
`;

const SELECT_CONTACT = 'SELECT id, parent, lineage FROM contacts WHERE id = $1';
const SELECT_DESCENDANTS = 'SELECT id, lineage FROM contacts WHERE $1 = ANY(lineage)';
const UPDATE_CONTACT_LINEAGE = 'UPDATE contacts SET lineage = $1 WHERE id = $2';
const DELETE_CONTACT = 'DELETE FROM contacts WHERE id = $1';

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

// Build a sentinel-style record for a change-feed entry. The shared lib's
// `transform()` does the heavy lifting; sentinel handles the deleted-changes
// envelope, where the rev lives on `change.changes[0].rev` rather than on
// `change.doc._rev`.
const buildRecord = (change) => {
  if (change.deleted) {
    const rev = (change.changes && change.changes[0] && change.changes[0].rev) ||
      (change.doc && change.doc._rev) ||
      null;
    const tombstoneDoc = {
      _id: change.id,
      _rev: rev || '0',
      _deleted: true,
    };
    return pgSync.transform(tombstoneDoc);
  }
  return pgSync.transform(change.doc);
};

const processChange = async (client, change) => {
  if (isMalformed(change)) {
    return { skipped: true, reason: 'malformed' };
  }

  const record = buildRecord(change);

  // For contact docs we need to: (1) look up the previous lineage so we know
  // whether to cascade, (2) compute the new lineage from the parent, (3) write.
  let previousContact = null;
  if (record.contact) {
    previousContact = await lookupContact(client, record.contact.id);
    record.contact.lineage = await computeLineageForParent(client, record.contact.parent);
  }

  await pgSync.write([record], client);

  if (change.deleted) {
    await client.query(DELETE_CONTACT, [change.id]);
    return { ok: true };
  }

  if (record.contact && previousContact
    && !arraysEqual(previousContact.lineage || [], record.contact.lineage)) {
    await cascadeLineage(client, record.contact.id, record.contact.lineage);
    // The contact's subject (its own id) hasn't changed, but re-stamp it on
    // documents rows referencing this contact to handle the edge case
    // where prior writes landed with subject = null.
    await client.query(UPDATE_DOC_SUBJECT_BY_ID, [record.contact.id, record.contact.id]);
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
    } catch {
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
  sanitize: pgSync.sanitize,
  _sql: {
    SELECT_PROGRESS,
    UPSERT_PROGRESS,
    SELECT_CONTACT,
    SELECT_DESCENDANTS,
    UPDATE_CONTACT_LINEAGE,
    DELETE_CONTACT,
    UPDATE_DOC_SUBJECT_BY_ID,
  },
};
