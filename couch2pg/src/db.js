const requireEnv = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
};

const getCouchUrl = () => requireEnv('COUCH_URL');

const getPostgresUrl = () => requireEnv('POSTGRES_URL');

let pool;

const getPool = () => {
  if (!pool) {
    // Lazy-require so test modules that inject a fake pool never load pg.
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: getPostgresUrl() });
  }
  return pool;
};

const closePool = async () => {
  if (pool) {
    await pool.end();
    pool = null;
  }
};

const ensureProgressTable = async (pool) => {
  const client = await pool.connect();
  try {
    // TODO(task-2): move this DDL into postgres-sync-setup.sql; Task 1 only
    // owns it transiently for the PoC so the mirror can resume after restart.
    await client.query(`
      CREATE TABLE IF NOT EXISTS couch2pg_progress (
        source VARCHAR(512) PRIMARY KEY,
        seq VARCHAR(512) NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  } finally {
    client.release();
  }
};

module.exports = {
  getCouchUrl,
  getPostgresUrl,
  getPool,
  closePool,
  ensureProgressTable,
};
