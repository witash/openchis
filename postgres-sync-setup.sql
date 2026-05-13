-- Table to simulate CouchDB documents in PostgreSQL
-- This table stores document revisions with postgres-native sequence for change tracking
-- couchdb_seq stores the original CouchDB sequence string for reference

CREATE TABLE IF NOT EXISTS medic_documents (
  _id VARCHAR(255) NOT NULL,
  _rev VARCHAR(255) NOT NULL,
  seq BIGSERIAL,
  couchdb_seq VARCHAR(512),
  doc JSONB NOT NULL,
  subject VARCHAR(255),
  type VARCHAR(50),
  deleted BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (_id, _rev)
);

-- Index on seq for efficient queries of changes since a given sequence
CREATE INDEX IF NOT EXISTS idx_medic_documents_seq ON medic_documents(seq);

-- Optional: Index on _id for faster lookups by document ID
CREATE INDEX IF NOT EXISTS idx_medic_documents_id ON medic_documents(_id);

-- Index on subject for efficient authorization queries
CREATE INDEX IF NOT EXISTS idx_medic_documents_subject ON medic_documents(subject);

-- Index on type for doc_by_type view
CREATE INDEX IF NOT EXISTS idx_medic_documents_type ON medic_documents(type);

-- Contacts table for authorization
-- This table stores contact type documents (contact, person, health_center, district_hospital)
-- for efficient authorization queries based on the contact hierarchy

CREATE TABLE IF NOT EXISTS contacts (
  id VARCHAR(255) PRIMARY KEY,
  type VARCHAR(50) NOT NULL,
  contact_type VARCHAR(50),
  parent VARCHAR(255),
  lineage TEXT[], -- Array of ancestor IDs from immediate parent up the hierarchy
  name VARCHAR(255),
  muted TIMESTAMP,
  phone VARCHAR(100),
  shortcode VARCHAR(100)
);

-- Index on parent for efficient hierarchy queries
CREATE INDEX IF NOT EXISTS idx_contacts_parent ON contacts(parent);

-- Index on type for filtering by contact type
CREATE INDEX IF NOT EXISTS idx_contacts_type ON contacts(type);

-- Index on contact_type for contacts_by_type view
CREATE INDEX IF NOT EXISTS idx_contacts_contact_type ON contacts(contact_type);

-- GIN index on lineage for efficient authorization queries
CREATE INDEX IF NOT EXISTS idx_contacts_lineage ON contacts USING GIN (lineage);

-- Additional indexes for contact views
CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);
CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);
CREATE INDEX IF NOT EXISTS idx_contacts_shortcode ON contacts(shortcode);

-- Attachments table
-- This table stores document attachments separately from the document JSON
-- Attachments are stored as base64 encoded text

CREATE TABLE IF NOT EXISTS attachments (
  doc_id VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  content_type VARCHAR(255) NOT NULL,
  digest VARCHAR(255),
  length BIGINT,
  revpos INT,
  data TEXT NOT NULL,
  PRIMARY KEY (doc_id, name)
);

-- Index on doc_id for efficient lookups
CREATE INDEX IF NOT EXISTS idx_attachments_doc_id ON attachments(doc_id);

-- Users table
-- This table stores user documents from the _users database
-- For backward compatibility, the entire document is stored as JSONB

CREATE TABLE IF NOT EXISTS users (
  _id VARCHAR(255) NOT NULL,
  _rev VARCHAR(255) NOT NULL,
  seq BIGSERIAL,
  couchdb_seq VARCHAR(512),
  doc JSONB NOT NULL,
  PRIMARY KEY (_id, _rev)
);

-- Index on seq for efficient queries of changes since a given sequence
CREATE INDEX IF NOT EXISTS idx_users_seq ON users(seq);

-- Index on _id for faster lookups by user ID
CREATE INDEX IF NOT EXISTS idx_users_id ON users(_id);

-- Index on username (extracted from doc) for login lookups
CREATE INDEX IF NOT EXISTS idx_users_name ON users((doc->>'name'));

-- Sessions table for offline user authentication
-- Stores session information for users authenticated via postgres instead of CouchDB
CREATE TABLE IF NOT EXISTS sessions (
  session_id VARCHAR(255) PRIMARY KEY,
  username VARCHAR(255) NOT NULL,
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000,
  expires_at BIGINT NOT NULL,
  user_ctx JSONB NOT NULL
);

-- Index on username for looking up user sessions
CREATE INDEX IF NOT EXISTS idx_sessions_username ON sessions(username);

-- Index on expires_at for cleaning up expired sessions
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

-- Reports table
-- Stores data_record type documents with extracted subject and contact fields
CREATE TABLE IF NOT EXISTS reports (
  id VARCHAR(255) PRIMARY KEY,
  type VARCHAR(50) NOT NULL,
  subject VARCHAR(255),
  contact VARCHAR(255),
  form VARCHAR(255),
  reported_date BIGINT,
  verified BOOLEAN,
  has_errors BOOLEAN,
  visited_contact_uuid VARCHAR(255),
  visited_date BIGINT
);

-- Index on subject for authorization queries
CREATE INDEX IF NOT EXISTS idx_reports_subject ON reports(subject);

-- Index on contact for queries by contact
CREATE INDEX IF NOT EXISTS idx_reports_contact ON reports(contact);

-- Additional indexes for report views
CREATE INDEX IF NOT EXISTS idx_reports_form ON reports(form);
CREATE INDEX IF NOT EXISTS idx_reports_reported_date ON reports(reported_date);
CREATE INDEX IF NOT EXISTS idx_reports_verified ON reports(verified);
CREATE INDEX IF NOT EXISTS idx_reports_has_errors ON reports(has_errors);
CREATE INDEX IF NOT EXISTS idx_reports_visited_contact_uuid ON reports(visited_contact_uuid);
CREATE INDEX IF NOT EXISTS idx_reports_visited_date ON reports(visited_date);

-- Tasks table for tasks_by_contact view
CREATE TABLE IF NOT EXISTS tasks (
  id VARCHAR(255) PRIMARY KEY,
  type VARCHAR(50) NOT NULL DEFAULT 'task',
  owner VARCHAR(255),
  requester VARCHAR(255),
  state VARCHAR(50)
);

CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner);
CREATE INDEX IF NOT EXISTS idx_tasks_requester ON tasks(requester);
CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);

-- Client sync state table
-- Stores the client's sync state when upgrading from Nairobi protocol to postgres sync
-- This allows resuming from where the Nairobi protocol left off
CREATE TABLE IF NOT EXISTS client_sync_state (
  username VARCHAR(255) PRIMARY KEY,
  pouchdb_upgrade_seq VARCHAR(255),  -- The PouchDB seq when client switched to postgres
  postgres_start_seq BIGINT,          -- The postgres seq at time of upgrade
  created_at TIMESTAMP DEFAULT NOW()
);

-- Index on username for fast lookups
CREATE INDEX IF NOT EXISTS idx_client_sync_state_username ON client_sync_state(username);
