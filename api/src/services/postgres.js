const { Pool } = require('pg');
const logger = require('@medic/logger');
const { getSubject } = require('./subject-extractor');

const { UNIT_TEST_ENV } = process.env;

// Postgres connection for simulating CouchDB sync
const postgresPool = UNIT_TEST_ENV ? null : new Pool({
  user: 'postgres',
  password: 'postgres',
  host: 'localhost',
  port: 5432,
  max: 10,
  database: 'postgres'
});

// Contact types that should be stored in the contacts table
const CONTACT_TYPES = ['contact', 'person', 'health_center', 'district_hospital', 'clinic'];

const isContactType = (doc) => {
  return doc.type && CONTACT_TYPES.includes(doc.type);
};

const extractParentId = (doc) => {
  if (!doc.parent) {
    return null;
  }
  // Parent can be either a string (id) or an object with _id
  return typeof doc.parent === 'string' ? doc.parent : doc.parent._id;
};

// Extract lineage array from nested parent objects
// Returns array of ancestor IDs from immediate parent up the hierarchy
// Stops at a max depth of 20 for safety
const extractLineage = (doc) => {
  const lineage = [];
  let current = doc.parent;
  let depth = 0;
  const MAX_DEPTH = 20;

  while (current && depth < MAX_DEPTH) {
    if (typeof current === 'string') {
      lineage.push(current);
      break; // Can't traverse further if it's just an ID string
    }
    if (current._id) {
      lineage.push(current._id);
    }
    current = current.parent;
    depth++;
  }

  return lineage;
};

const insertContactIfNeeded = async (doc) => {
  if (!isContactType(doc)) {
    return;
  }

  const parentId = extractParentId(doc);
  const lineage = extractLineage(doc);
  // contact_type is the contact_type field for type='contact', otherwise it's the type itself
  const contactType = doc.type === 'contact' ? doc.contact_type : doc.type;

  try {
    await postgresPool.query(
      `INSERT INTO contacts (id, type, contact_type, parent, lineage, name, muted, phone, shortcode)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET type = $2, contact_type = $3, parent = $4, lineage = $5, name = $6, muted = $7, phone = $8, shortcode = $9`,
      [
        doc._id,
        doc.type,
        contactType,
        parentId,
        lineage,
        doc.name || null,
        doc.muted ? new Date(doc.muted) : null,
        doc.phone || null,
        doc.patient_id || doc.place_id || null
      ]
    );
  } catch (err) {
    logger.error(`Error inserting contact ${doc._id}: %o`, err);
    // Don't fail the whole operation if contact insert fails
  }
};

const extractContactId = (doc) => {
  if (!doc.contact) {
    return null;
  }
  // Contact can be either a string (id) or an object with _id
  return typeof doc.contact === 'string' ? doc.contact : doc.contact._id;
};

// Extract report fields from doc and doc.fields
const extractReportFields = (doc) => {
  const fields = doc.fields || {};
  return {
    form: doc.form || null,
    reported_date: doc.reported_date || null,
    verified: doc.verified !== undefined ? doc.verified : null,
    has_errors: !!(doc.errors && doc.errors.length > 0),
    visited_contact_uuid: fields.visited_contact_uuid || null,
    visited_date: fields.visited_date ? Date.parse(fields.visited_date) : null
  };
};

const insertReportIfNeeded = async (doc, subject) => {
  if (doc.type !== 'data_record') {
    return;
  }

  const contactId = extractContactId(doc);
  const rf = extractReportFields(doc);

  try {
    await postgresPool.query(
      `INSERT INTO reports (id, type, subject, contact, form, reported_date, verified, has_errors, visited_contact_uuid, visited_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO UPDATE SET type = $2, subject = $3, contact = $4, form = $5, reported_date = $6, verified = $7, has_errors = $8, visited_contact_uuid = $9, visited_date = $10`,
      [
        doc._id, doc.type, subject, contactId,
        rf.form, rf.reported_date, rf.verified, rf.has_errors,
        rf.visited_contact_uuid, rf.visited_date
      ]
    );
  } catch (err) {
    logger.error(`Error inserting report ${doc._id}: %o`, err);
    // Don't fail the whole operation if report insert fails
  }
};

const insertTaskIfNeeded = async (doc) => {
  if (doc.type !== 'task') {
    return;
  }

  try {
    await postgresPool.query(
      `INSERT INTO tasks (id, type, owner, requester, state)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET type = $2, owner = $3, requester = $4, state = $5`,
      [doc._id, doc.type, doc.owner || null, doc.requester || null, doc.state || null]
    );
  } catch (err) {
    logger.error(`Error inserting task ${doc._id}: %o`, err);
  }
};

// Store attachments in postgres and return doc with stubs
const storeAttachments = async (doc, medicDb, fetchFromCouchDB = true) => {
  if (!doc._attachments) {
    return doc;
  }

  // Check if we need to fetch full attachments from CouchDB
  const hasStubs = Object.values(doc._attachments).some(att => att.stub === true);

  let fullDoc = doc;
  if (hasStubs && fetchFromCouchDB && medicDb) {
    try {
      fullDoc = await medicDb.get(doc._id, {
        rev: doc._rev,
        attachments: true,
        binary: false
      });
    } catch (err) {
      logger.error(`Error fetching attachments for ${doc._id}: %o`, err);
      return doc;
    }
  }

  // Store each attachment
  for (const [name, att] of Object.entries(fullDoc._attachments)) {
    if (att.data) {
      try {
        await postgresPool.query(
          `INSERT INTO attachments (doc_id, name, content_type, digest, length, revpos, data)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (doc_id, name) DO UPDATE SET content_type = $3, digest = $4, length = $5, revpos = $6, data = $7`,
          [doc._id, name, att.content_type, att.digest, att.length, att.revpos, att.data]
        );
      } catch (err) {
        logger.error(`Error storing attachment ${name} for ${doc._id}: %o`, err);
      }
    }
  }

  // Return doc with stubs (no data) to store in medic_documents
  const docWithStubs = { ...fullDoc };
  if (docWithStubs._attachments) {
    docWithStubs._attachments = {};
    for (const [name, att] of Object.entries(fullDoc._attachments)) {
      docWithStubs._attachments[name] = {
        content_type: att.content_type,
        digest: att.digest,
        length: att.length,
        revpos: att.revpos,
        stub: true
      };
    }
  }

  return docWithStubs;
};

// Shared function to save a document to postgres
// Used by the changes listener - accepts change object with seq from CouchDB
// seq is auto-generated by postgres (BIGSERIAL), couchdb_seq stores the original CouchDB sequence string
const saveDocToPostgres = async (change, medicDb, options = {}) => {
  const { fetchAttachmentsFromCouchDB = true } = options;
  // Support both change object (from changes listener) and raw doc
  const doc = change.doc || change;
  const couchdbSeq = change.seq ? String(change.seq) : null;  // CouchDB sequence as string
  const { _id, _rev } = doc;

  // Store attachments separately and get doc with stubs
  const docWithStubs = await storeAttachments(doc, medicDb, fetchAttachmentsFromCouchDB);

  const docJson = JSON.stringify(docWithStubs);
  const subject = getSubject(doc);
  const docType = doc.type || null;

  // seq is auto-generated by postgres BIGSERIAL, we store couchdb_seq for reference
  await postgresPool.query(
    'INSERT INTO medic_documents (_id, _rev, couchdb_seq, doc, subject, type) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (_id, _rev) DO UPDATE SET doc = $4, subject = $5, couchdb_seq = $3, type = $6',
    [_id, _rev, couchdbSeq, docJson, subject, docType]
  );

  // If this is a contact document, also insert into contacts table
  await insertContactIfNeeded(doc);

  // If this is a report (data_record), also insert into reports table
  await insertReportIfNeeded(doc, subject);

  // If this is a task, also insert into tasks table
  await insertTaskIfNeeded(doc);
};

// Batch save multiple documents to postgres in single queries
// Note: This function is typically used when documents don't have seq numbers (not from changes feed)
// seq is auto-generated by postgres BIGSERIAL, couchdb_seq stores the original CouchDB sequence string
const saveDocsToPostgresBatch = async (docs, options = {}) => {
  // Prepare data for batch inserts
  const medicDocsValues = [];
  const medicDocsParams = [];
  const contactsValues = [];
  const contactsParams = [];
  const reportsValues = [];
  const reportsParams = [];
  const tasksValues = [];
  const tasksParams = [];
  const attachmentsValues = [];
  const attachmentsParams = [];

  let medicParamIdx = 1;
  let contactParamIdx = 1;
  let reportParamIdx = 1;
  let taskParamIdx = 1;
  let attachmentParamIdx = 1;

  for (const item of docs) {
    // Support both raw docs and change objects with seq
    const doc = item.doc || item;
    const couchdbSeq = item.seq ? String(item.seq) : null;  // CouchDB sequence as string
    const { _id, _rev } = doc;
    if (!_id || !_rev) {
      continue;
    }

    // Process attachments - convert to stubs for main doc storage
    let docToStore = doc;
    if (doc._attachments) {
      // Store attachment data
      for (const [name, att] of Object.entries(doc._attachments)) {
        if (att.data) {
          attachmentsValues.push(`($${attachmentParamIdx}, $${attachmentParamIdx + 1}, $${attachmentParamIdx + 2}, $${attachmentParamIdx + 3}, $${attachmentParamIdx + 4}, $${attachmentParamIdx + 5}, $${attachmentParamIdx + 6})`);
          attachmentsParams.push(_id, name, att.content_type, att.digest, att.length, att.revpos, att.data);
          attachmentParamIdx += 7;
        }
      }

      // Convert to stubs for main doc
      docToStore = { ...doc };
      docToStore._attachments = {};
      for (const [name, att] of Object.entries(doc._attachments)) {
        docToStore._attachments[name] = {
          content_type: att.content_type,
          digest: att.digest,
          length: att.length,
          revpos: att.revpos,
          stub: true
        };
      }
    }

    const docJson = JSON.stringify(docToStore);
    const subject = getSubject(doc);
    const docType = doc.type || null;

    // medic_documents insert - seq is auto-generated, store couchdb_seq for reference
    medicDocsValues.push(`($${medicParamIdx}, $${medicParamIdx + 1}, $${medicParamIdx + 2}, $${medicParamIdx + 3}, $${medicParamIdx + 4}, $${medicParamIdx + 5})`);
    medicDocsParams.push(_id, _rev, couchdbSeq, docJson, subject, docType);
    medicParamIdx += 6;

    // contacts insert if needed
    if (isContactType(doc)) {
      const parentId = extractParentId(doc);
      const lineage = extractLineage(doc);
      const contactType = doc.type === 'contact' ? doc.contact_type : doc.type;
      contactsValues.push(`($${contactParamIdx}, $${contactParamIdx + 1}, $${contactParamIdx + 2}, $${contactParamIdx + 3}, $${contactParamIdx + 4}, $${contactParamIdx + 5}, $${contactParamIdx + 6}, $${contactParamIdx + 7}, $${contactParamIdx + 8})`);
      contactsParams.push(
        _id, doc.type, contactType, parentId, lineage,
        doc.name || null,
        doc.muted ? new Date(doc.muted) : null,
        doc.phone || null,
        doc.patient_id || doc.place_id || null
      );
      contactParamIdx += 9;
    }

    // reports insert if needed
    if (doc.type === 'data_record') {
      const contactId = extractContactId(doc);
      const rf = extractReportFields(doc);
      reportsValues.push(`($${reportParamIdx}, $${reportParamIdx + 1}, $${reportParamIdx + 2}, $${reportParamIdx + 3}, $${reportParamIdx + 4}, $${reportParamIdx + 5}, $${reportParamIdx + 6}, $${reportParamIdx + 7}, $${reportParamIdx + 8}, $${reportParamIdx + 9})`);
      reportsParams.push(
        _id, doc.type, subject, contactId,
        rf.form, rf.reported_date, rf.verified, rf.has_errors,
        rf.visited_contact_uuid, rf.visited_date
      );
      reportParamIdx += 10;
    }

    // tasks insert if needed
    if (doc.type === 'task') {
      tasksValues.push(`($${taskParamIdx}, $${taskParamIdx + 1}, $${taskParamIdx + 2}, $${taskParamIdx + 3}, $${taskParamIdx + 4})`);
      tasksParams.push(_id, doc.type, doc.owner || null, doc.requester || null, doc.state || null);
      taskParamIdx += 5;
    }
  }

  // Execute batch inserts
  const queries = [];

  if (medicDocsValues.length > 0) {
    queries.push(postgresPool.query(
      `INSERT INTO medic_documents (_id, _rev, couchdb_seq, doc, subject, type) VALUES ${medicDocsValues.join(', ')}
       ON CONFLICT (_id, _rev) DO UPDATE SET doc = EXCLUDED.doc, subject = EXCLUDED.subject, couchdb_seq = COALESCE(EXCLUDED.couchdb_seq, medic_documents.couchdb_seq), type = EXCLUDED.type`,
      medicDocsParams
    ));
  }

  if (contactsValues.length > 0) {
    queries.push(postgresPool.query(
      `INSERT INTO contacts (id, type, contact_type, parent, lineage, name, muted, phone, shortcode) VALUES ${contactsValues.join(', ')}
       ON CONFLICT (id) DO UPDATE SET type = EXCLUDED.type, contact_type = EXCLUDED.contact_type, parent = EXCLUDED.parent, lineage = EXCLUDED.lineage, name = EXCLUDED.name, muted = EXCLUDED.muted, phone = EXCLUDED.phone, shortcode = EXCLUDED.shortcode`,
      contactsParams
    ));
  }

  if (reportsValues.length > 0) {
    queries.push(postgresPool.query(
      `INSERT INTO reports (id, type, subject, contact, form, reported_date, verified, has_errors, visited_contact_uuid, visited_date) VALUES ${reportsValues.join(', ')}
       ON CONFLICT (id) DO UPDATE SET type = EXCLUDED.type, subject = EXCLUDED.subject, contact = EXCLUDED.contact, form = EXCLUDED.form, reported_date = EXCLUDED.reported_date, verified = EXCLUDED.verified, has_errors = EXCLUDED.has_errors, visited_contact_uuid = EXCLUDED.visited_contact_uuid, visited_date = EXCLUDED.visited_date`,
      reportsParams
    ));
  }

  if (tasksValues.length > 0) {
    queries.push(postgresPool.query(
      `INSERT INTO tasks (id, type, owner, requester, state) VALUES ${tasksValues.join(', ')}
       ON CONFLICT (id) DO UPDATE SET type = EXCLUDED.type, owner = EXCLUDED.owner, requester = EXCLUDED.requester, state = EXCLUDED.state`,
      tasksParams
    ));
  }

  if (attachmentsValues.length > 0) {
    queries.push(postgresPool.query(
      `INSERT INTO attachments (doc_id, name, content_type, digest, length, revpos, data) VALUES ${attachmentsValues.join(', ')}
       ON CONFLICT (doc_id, name) DO UPDATE SET content_type = EXCLUDED.content_type, digest = EXCLUDED.digest, length = EXCLUDED.length, revpos = EXCLUDED.revpos, data = EXCLUDED.data`,
      attachmentsParams
    ));
  }

  await Promise.all(queries);
};

// Save user document to postgres
// Accepts change object with seq from CouchDB changes feed
// seq is auto-generated by postgres (BIGSERIAL), couchdb_seq stores the original CouchDB sequence string
const saveUserToPostgres = async (change) => {
  // Support both change object and raw doc
  const doc = change.doc || change;
  const couchdbSeq = change.seq ? String(change.seq) : null;  // CouchDB sequence as string
  const { _id, _rev } = doc;
  const docJson = JSON.stringify(doc);

  await postgresPool.query(
    'INSERT INTO users (_id, _rev, couchdb_seq, doc) VALUES ($1, $2, $3, $4) ON CONFLICT (_id, _rev) DO UPDATE SET doc = $4, couchdb_seq = $3',
    [_id, _rev, couchdbSeq, docJson]
  );

  logger.debug(`Saved user ${_id} rev ${_rev} couchdb_seq ${couchdbSeq} to postgres`);
};

module.exports = {
  pool: postgresPool,
  saveDocToPostgres,
  saveDocsToPostgresBatch,
  saveUserToPostgres,
  isContactType,
  extractParentId,
  extractContactId,
  extractLineage
};
