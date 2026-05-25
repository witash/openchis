// Derives `subject`, `type`, and contact/report/task metadata for a CouchDB
// document. Mirrors the rules in
// ddocs/medic-db/medic/nouveau/docs_by_replication_key/index.js — if this
// file and the view disagree, the view wins.

const HARDCODED_CONTACT_TYPES = new Set([
  'person',
  'clinic',
  'health_center',
  'district_hospital',
]);

const SYSTEM_DOC_IDS = new Set([
  'resources',
  'branding',
  'partners',
  'service-worker-meta',
  'zscore-charts',
  'settings',
  'privacy-policies',
]);

const ALL_SUBJECT = '_all';
const MEDIC_CLIENT_DDOC = '_design/medic-client';

const isSystemDoc = (doc) => {
  if (!doc) {
    return false;
  }
  if (SYSTEM_DOC_IDS.has(doc._id)) {
    return true;
  }
  return doc.type === 'form' || doc.type === 'translations';
};

const isGlobalDoc = (doc) => {
  if (!doc) {
    return false;
  }
  if (doc._id === MEDIC_CLIENT_DDOC) {
    return true;
  }
  return isSystemDoc(doc);
};

const isContactDoc = (doc) => {
  if (!doc || typeof doc !== 'object') {
    return false;
  }
  if (doc.type === 'contact') {
    return true;
  }
  return HARDCODED_CONTACT_TYPES.has(doc.type);
};

const getDocType = (doc) => {
  if (!doc || typeof doc.type !== 'string') {
    return null;
  }
  return doc.type;
};

const getContactType = (doc) => {
  if (!doc) {
    return null;
  }
  if (doc.type === 'contact' && typeof doc.contact_type === 'string') {
    return doc.contact_type;
  }
  if (HARDCODED_CONTACT_TYPES.has(doc.type)) {
    return doc.type;
  }
  return null;
};

const getParentId = (doc) => {
  if (!doc || !doc.parent) {
    return null;
  }
  if (typeof doc.parent === 'string') {
    return doc.parent;
  }
  return doc.parent._id || null;
};

const getDataRecordSubject = (doc) => {
  if (doc.form && doc.contact && Array.isArray(doc.errors) && doc.errors.length) {
    for (const err of doc.errors) {
      if (err && (err.code === 'registration_not_found' || err.code === 'invalid_patient_id')) {
        return doc.contact._id;
      }
    }
  }
  if (doc.form) {
    return doc.patient_id
      || (doc.fields && doc.fields.patient_id)
      || doc.place_id
      || (doc.fields && doc.fields.place_id)
      || (doc.fields && doc.fields.patient_uuid)
      || (doc.contact && doc.contact._id)
      || null;
  }
  if (doc.sms_message) {
    return (doc.contact && doc.contact._id) || null;
  }
  if (doc.kujua_message) {
    return (
      doc.tasks
      && doc.tasks[0]
      && doc.tasks[0].messages
      && doc.tasks[0].messages[0]
      && doc.tasks[0].messages[0].contact
      && doc.tasks[0].messages[0].contact._id
    ) || null;
  }
  return null;
};

const getSubject = (doc) => {
  if (!doc) {
    return null;
  }
  if (isGlobalDoc(doc)) {
    return ALL_SUBJECT;
  }
  if (isContactDoc(doc)) {
    return doc._id || null;
  }
  if (doc.type === 'user-settings') {
    return doc._id || null;
  }
  switch (doc.type) {
    case 'data_record':
      return getDataRecordSubject(doc) || '_unassigned';
    case 'task':
      return doc.user || doc.owner || null;
    case 'target':
      return doc.owner || null;
    default:
      return null;
  }
};

// Pure transform: CouchDB doc → records ready for write().
// Returns { document, contact?, report?, task? } or null when the doc lacks
// _id (or _rev for non-deleted docs).
const transform = (doc) => {
  if (!doc || typeof doc !== 'object' || !doc._id) {
    return null;
  }

  if (doc._deleted) {
    const rev = doc._rev || '0';
    return {
      document: {
        _id: doc._id,
        _rev: rev,
        doc: { _id: doc._id, _rev: rev, _deleted: true },
        subject: null,
        type: null,
        deleted: true,
      },
    };
  }

  if (!doc._rev) {
    return null;
  }

  const record = {
    document: {
      _id: doc._id,
      _rev: doc._rev,
      doc,
      subject: getSubject(doc),
      type: getDocType(doc),
      deleted: false,
    },
  };

  if (isContactDoc(doc)) {
    record.contact = {
      id: doc._id,
      type: doc.type || null,
      contact_type: getContactType(doc),
      parent: getParentId(doc),
      name: typeof doc.name === 'string' ? doc.name : null,
      muted: doc.muted ? new Date(doc.muted) : null,
      phone: typeof doc.phone === 'string' ? doc.phone : null,
      shortcode: typeof doc.shortcode === 'string' ? doc.shortcode : null,
    };
  }

  if (doc.type === 'data_record') {
    record.report = {
      id: doc._id,
      subject: getDataRecordSubject(doc),
      contact: (doc.contact && doc.contact._id) || null,
      form: typeof doc.form === 'string' ? doc.form : null,
      reported_date: typeof doc.reported_date === 'number' ? doc.reported_date : null,
    };
  }

  if (doc.type === 'task') {
    record.task = {
      id: doc._id,
      owner: typeof doc.owner === 'string' ? doc.owner : null,
      requester: typeof doc.requester === 'string' ? doc.requester : null,
      state: typeof doc.state === 'string' ? doc.state : null,
    };
  }

  return record;
};

module.exports = {
  ALL_SUBJECT,
  MEDIC_CLIENT_DDOC,
  isContactDoc,
  isGlobalDoc,
  isSystemDoc,
  getDocType,
  getContactType,
  getParentId,
  getSubject,
  getDataRecordSubject,
  transform,
};
