// Extracts the subject (replication key) from a document
// Based on ddocs/medic-db/medic/nouveau/docs_by_replication_key/index.js

const GLOBAL_DOC_IDS = [
  'resources',
  'branding',
  'partners',
  'service-worker-meta',
  'zscore-charts',
  'settings',
  'privacy-policies'
];

const GLOBAL_DOC_TYPES = ['form', 'translations'];

const CONTACT_TYPES = ['contact', 'clinic', 'district_hospital', 'health_center', 'person'];

const getSubjectForReport = (doc) => {
  if (doc.form) {
    // report
    if (doc.contact && doc.errors && doc.errors.length) {
      for (let i = 0; i < doc.errors.length; i++) {
        // invalid or no patient found, fall back to using contact. #3437
        if (doc.errors[i].code === 'registration_not_found' ||
            doc.errors[i].code === 'invalid_patient_id') {
          return doc.contact._id;
        }
      }
    }
    return (doc.patient_id || (doc.fields && doc.fields.patient_id)) ||
           (doc.place_id || (doc.fields && doc.fields.place_id)) ||
           (doc.fields && doc.fields.patient_uuid) ||
           (doc.contact && doc.contact._id);
  }
  if (doc.sms_message) {
    // incoming message
    return doc.contact && doc.contact._id;
  }
  if (doc.kujua_message) {
    // outgoing message
    return doc.tasks &&
           doc.tasks[0] &&
           doc.tasks[0].messages &&
           doc.tasks[0].messages[0] &&
           doc.tasks[0].messages[0].contact &&
           doc.tasks[0].messages[0].contact._id;
  }
};

const getSubject = (doc) => {
  // Global documents accessible to all users
  if (GLOBAL_DOC_IDS.includes(doc._id) || GLOBAL_DOC_TYPES.includes(doc.type)) {
    return '_all';
  }

  switch (doc.type) {
    case 'data_record':
      return getSubjectForReport(doc) || '_unassigned';
    case 'task':
      return doc.user;
    case 'target':
      return doc.owner;
    case 'contact':
    case 'clinic':
    case 'district_hospital':
    case 'health_center':
    case 'person':
      return doc._id;
    default:
      return null;
  }
};

module.exports = {
  getSubject
};
