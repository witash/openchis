// Derives `subject`, `type`, and contact metadata for a CouchDB document.
//
// The canonical rules live in
// ddocs/medic-db/medic/nouveau/docs_by_replication_key/index.js. Per PROJECT.md
// the view is authoritative — if this file and the view ever disagree, the
// view wins and this file is updated to match.

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

const isSystemDoc = (doc) => {
  if (!doc) {
    return false;
  }
  if (SYSTEM_DOC_IDS.has(doc._id)) {
    return true;
  }
  return doc.type === 'form' || doc.type === 'translations';
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

// Mirrors the view's getSubject() for `data_record` (report) docs.
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
  if (isSystemDoc(doc)) {
    return null;
  }
  if (isContactDoc(doc)) {
    return doc._id || null;
  }
  switch (doc.type) {
    case 'data_record':
      return getDataRecordSubject(doc) || '_unassigned';
    case 'task':
    // The view keys tasks by `doc.user`. PROJECT.md says "view wins".
      return doc.user || null;
    case 'target':
      return doc.owner || null;
    default:
      return null;
  }
};

module.exports = {
  isContactDoc,
  isSystemDoc,
  getDocType,
  getContactType,
  getParentId,
  getSubject,
  getDataRecordSubject,
};
