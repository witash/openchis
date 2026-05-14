const environment = require('@medic/environment');

const getCouchUrl = () => environment.couchUrl;

const getPostgresUrl = () => {
  const value = process.env.POSTGRES_URL;
  if (!value) {
    throw new Error('Required environment variable POSTGRES_URL is not set');
  }
  return value;
};

let pool;

// Indirection so unit tests can substitute the pool factory without needing
// `pg` installed. Production callers never set this.
let createPool = (connectionString) => {
   
  const { Pool } = require('pg');
  return new Pool({ connectionString });
};

const getPool = () => {
  if (!pool) {
    pool = createPool(getPostgresUrl());
  }
  return pool;
};

const closePool = async () => {
  if (pool) {
    await pool.end();
    pool = null;
  }
};

const ensureProgressTable = async (pgPool) => {
  const client = await pgPool.connect();
  try {
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
  _setCreatePool: (fn) => {
    createPool = fn; 
  },
  _resetPool: () => {
    pool = null; 
  },
};
