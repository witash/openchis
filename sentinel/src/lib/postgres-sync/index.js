const logger = require('@medic/logger');
const db = require('./db');
const watcher = require('./watcher');

// The mirror loop runs independently of sentinel's other work. It does not
// await any sentinel transition, scheduled task, or changes-feed promise.
// Its only persistence is the `couch2pg_progress` row in Postgres — separate
// from sentinel's TRANSITION_SEQ doc in the sentinel CouchDB database.
const start = async () => {
  const couchUrl = db.getCouchUrl();
  const pool = db.getPool();
  await db.ensureProgressTable(pool);

  logger.info(`postgres-sync: mirror started from ${couchUrl}`);
  await watcher.runForever({ pool, couchUrl });
};

const init = () => {
  if (!process.env.POSTGRES_URL) {
    logger.info('postgres-sync: POSTGRES_URL not set, mirror disabled');
    return;
  }

  // Fire-and-forget. The mirror must not block sentinel startup or its
  // scheduled tasks; failures here are logged but do not crash sentinel.
  start().catch((err) => {
    logger.error('postgres-sync: fatal error: %o', err);
  });
};

module.exports = {
  init,
  _start: start,
};
