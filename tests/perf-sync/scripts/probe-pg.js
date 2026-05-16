#!/usr/bin/env node
// Probe a list of candidate Postgres URLs and print the first working one.
// Returns exit 0 with the URL on stdout, exit 1 otherwise.

const { Client } = require('pg');

const attempts = [
  'postgres://postgres:postgres@localhost:5432/medic',
  'postgres://postgres:postgres@localhost:5432/postgres',
  'postgres://medic:password@localhost:5432/medic',
  'postgres://medic:medic@localhost:5432/medic',
  'postgres://postgres:password@localhost:5432/postgres',
  'postgres://postgres:password@localhost:5432/medic',
  'postgres://postgres:medic@localhost:5432/medic',
];

const tryOne = async (url) => {
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch (e) {
    return false;
  } finally {
    try { await client.end(); } catch (_) { /* noop */ }
  }
};

const main = async () => {
  for (const url of attempts) {
    if (await tryOne(url)) {
      process.stdout.write(url + '\n');
      process.exit(0);
    }
  }
  process.stderr.write('no working postgres url found\n');
  process.exit(1);
};

main();
