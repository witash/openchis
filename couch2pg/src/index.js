const db = require('./db');
const watcher = require('./watcher');

const main = async () => {
  const couchUrl = db.getCouchUrl();
  const pool = db.getPool();
  await db.ensureProgressTable(pool);

  console.log(`[couch2pg] mirroring from ${couchUrl}`);
  await watcher.runForever({ pool, couchUrl });
};

if (require.main === module) {
  main().catch((err) => {
    console.error('[couch2pg] fatal:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
