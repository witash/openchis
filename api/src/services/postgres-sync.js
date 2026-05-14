const logger = require('@medic/logger');

let pool;

let createPool = (connectionString) => {

  const { Pool } = require('pg');
  return new Pool({ connectionString });
};

const getPool = () => {
  if (pool) {
    return pool;
  }
  const url = process.env.POSTGRES_URL;
  if (!url) {
    logger.debug('postgres-sync: POSTGRES_URL not set, write-through disabled');
    return null;
  }
  pool = createPool(url);
  return pool;
};

const closePool = async () => {
  if (pool) {
    await pool.end();
    pool = null;
  }
};

module.exports = {
  getPool,
  closePool,
  _setCreatePool: (fn) => {
    createPool = fn;
  },
  _resetPool: () => {
    pool = null;
  },
};
