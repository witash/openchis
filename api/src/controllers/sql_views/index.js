// Index file that exports all SQL view implementations
const contacts_by_last_visited = require('./contacts_by_last_visited');
const contacts_by_type = require('./contacts_by_type');
const contacts_by_parent = require('./contacts_by_parent');
const contacts_by_phone = require('./contacts_by_phone');
const contacts_by_place = require('./contacts_by_place');
const contacts_by_reference = require('./contacts_by_reference');
const data_records_by_type = require('./data_records_by_type');
const doc_by_type = require('./doc_by_type');
const docs_by_id_lineage = require('./docs_by_id_lineage');
const messages_by_contact_date = require('./messages_by_contact_date');
const reports_by_date = require('./reports_by_date');
const reports_by_form = require('./reports_by_form');
const reports_by_place = require('./reports_by_place');
const reports_by_subject = require('./reports_by_subject');
const reports_by_validity = require('./reports_by_validity');
const reports_by_verification = require('./reports_by_verification');
const tasks_by_contact = require('./tasks_by_contact');
const visits_by_date = require('./visits_by_date');
const registered_patients = require('./registered_patients');

module.exports = {
  contacts_by_last_visited,
  contacts_by_type,
  contacts_by_parent,
  contacts_by_phone,
  contacts_by_place,
  contacts_by_reference,
  data_records_by_type,
  doc_by_type,
  docs_by_id_lineage,
  messages_by_contact_date,
  registered_patients,
  reports_by_date,
  reports_by_form,
  reports_by_place,
  reports_by_subject,
  reports_by_validity,
  reports_by_verification,
  tasks_by_contact,
  visits_by_date
};
