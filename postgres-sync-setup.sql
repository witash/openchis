-- documents: CouchDB document bodies, keyed by (_id, _rev).
-- subject/type are extracted for authorization and view filtering.
CREATE TABLE IF NOT EXISTS documents (
  _id VARCHAR(255) NOT NULL,
  _rev VARCHAR(255) NOT NULL,
  doc JSONB NOT NULL,
  subject VARCHAR(255),
  type VARCHAR(50),
  deleted BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (_id, _rev)
);

CREATE INDEX IF NOT EXISTS idx_documents_id ON documents(_id);
CREATE INDEX IF NOT EXISTS idx_documents_subject ON documents(subject);
CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(type);

-- contacts: extracted from contact-typed documents for authorization
-- (lineage drives the descendants-of-place query).
CREATE TABLE IF NOT EXISTS contacts (
  id VARCHAR(255) PRIMARY KEY,
  type VARCHAR(50) NOT NULL,
  contact_type VARCHAR(50),
  parent VARCHAR(255),
  lineage TEXT[],
  name VARCHAR(255),
  muted TIMESTAMP,
  phone VARCHAR(100),
  shortcode VARCHAR(100)
);

CREATE INDEX IF NOT EXISTS idx_contacts_parent ON contacts(parent);
CREATE INDEX IF NOT EXISTS idx_contacts_type ON contacts(type);
CREATE INDEX IF NOT EXISTS idx_contacts_contact_type ON contacts(contact_type);
CREATE INDEX IF NOT EXISTS idx_contacts_lineage ON contacts USING GIN (lineage);

-- reports: extracted from data_record documents.
CREATE TABLE IF NOT EXISTS reports (
  id VARCHAR(255) PRIMARY KEY,
  subject VARCHAR(255),
  contact VARCHAR(255),
  form VARCHAR(255),
  reported_date BIGINT
);

CREATE INDEX IF NOT EXISTS idx_reports_subject ON reports(subject);
CREATE INDEX IF NOT EXISTS idx_reports_contact ON reports(contact);
CREATE INDEX IF NOT EXISTS idx_reports_form ON reports(form);

-- tasks: extracted from task documents.
CREATE TABLE IF NOT EXISTS tasks (
  id VARCHAR(255) PRIMARY KEY,
  owner VARCHAR(255),
  requester VARCHAR(255),
  state VARCHAR(50)
);

CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner);
CREATE INDEX IF NOT EXISTS idx_tasks_requester ON tasks(requester);
