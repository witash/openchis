// Postgres connection pool wrapper for the pg-sync endpoint (PoC).
// Production code lazily instantiates a `pg.Pool` using `POSTGRES_URL`.
// Unit tests stub `query` directly so `pg` is never required.

let pool;

const getPool = () => {
  if (!pool) {
    // eslint-disable-next-line node/no-missing-require
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.POSTGRES_URL });
  }
  return pool;
};

module.exports = {
  query: (text, params) => getPool().query(text, params),
  end: async () => {
    if (pool) {
      await pool.end();
      pool = undefined;
    }
  },
};
