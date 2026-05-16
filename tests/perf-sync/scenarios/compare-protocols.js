'use strict';

// Compare-protocols scenario.
//
// Runs a single CHW's initial sync under BOTH protocols and reports the
// doc-id set difference. The PoC's bar (PROJECT.md) is that the two
// protocols should produce the same CHW-visible doc set — modulo
// tombstones, which pg-sync surfaces and nairobi does not.
//
// In practice we expect drift today: test-data-generator emits tasks with
// `doc.owner` but no `doc.user`. The CouchDB view
// `docs_by_replication_key` keys tasks by `doc.user`, so nairobi finds
// zero tasks for these CHWs; pg-sync's transform falls back to
// `doc.owner` per PROJECT.md and returns all 100 tasks per CHW. Surfacing
// this gap is the point of this scenario.
//
// Sequential (not Promise.all) by design: keeps the diff deterministic
// and avoids the two protocols racing each other against the API.

const setup = require('../lib/setup');
const { buildLocalPouch } = require('../lib/client');
const pgSync = require('../lib/protocols/pg-sync');
const nairobi = require('../lib/protocols/nairobi');

const SCENARIO = 'compare-protocols';
const DEFAULT_CHW_PASSWORD = 'password';

const loadPouch = () => {
  const PouchDB = require('pouchdb');
  if (!PouchDB.__perfSyncMemPluginLoaded) {
    PouchDB.plugin(require('pouchdb-adapter-memory'));
    PouchDB.__perfSyncMemPluginLoaded = true;
  }
  return PouchDB;
};

const collectDocIds = async (local) => {
  const resp = await local.allDocs({ include_docs: false });
  const ids = new Set();
  for (const row of resp.rows) {
    ids.add(row.id);
  }
  return ids;
};

const runProtocol = async ({ PouchDB, baseUrl, user, runId, protocol }) => {
  const local = buildLocalPouch(PouchDB, `compare-${protocol}-${runId}-${user.username}`);
  try {
    const t0 = Date.now();
    if (protocol === 'pg-sync') {
      await pgSync.sync({ local, baseUrl, user, fetchFn: globalThis.fetch });
    } else if (protocol === 'nairobi') {
      const remote = nairobi.makeRemote(PouchDB, baseUrl, user);
      await nairobi.sync({
        remote,
        local,
        replicateFn: PouchDB.replicate.bind(PouchDB),
        baseUrl,
        user,
        fetchFn: globalThis.fetch,
      });
    } else {
      throw new Error(`compare-protocols: unknown protocol ${protocol}`);
    }
    const ids = await collectDocIds(local);
    return { ids, elapsed_ms: Date.now() - t0 };
  } finally {
    try {
      await local.destroy();
    } catch (_destroyErr) { /* best effort */ }
  }
};

const formatDiff = ({ nairobiResult, pgResult, sample = 5 }) => {
  const inBoth = [...pgResult.ids].filter((id) => nairobiResult.ids.has(id));
  const onlyInPg = [...pgResult.ids].filter((id) => !nairobiResult.ids.has(id));
  const onlyInNairobi = [...nairobiResult.ids].filter((id) => !pgResult.ids.has(id));
  return {
    in_both: inBoth.length,
    only_in_pg: onlyInPg.length,
    only_in_nairobi: onlyInNairobi.length,
    only_in_pg_sample: onlyInPg.slice(0, sample),
    only_in_nairobi_sample: onlyInNairobi.slice(0, sample),
  };
};

const run = async ({ baseUrl, admin, userCount, runId, runSetupFn }) => {
  if (userCount !== 1) {
    process.stderr.write(`compare-protocols: only --users=1 is meaningful (got ${userCount}); using user 0.\n`);
  }
  const doSetup = runSetupFn || setup.runSetup;
  await doSetup({ baseUrl, admin, userCount: 1, runId });

  const user = { username: `perf-chw-${runId}-0`, password: DEFAULT_CHW_PASSWORD };
  const PouchDB = loadPouch();

  const nairobiResult = await runProtocol({ PouchDB, baseUrl, user, runId, protocol: 'nairobi' });
  const pgResult = await runProtocol({ PouchDB, baseUrl, user, runId, protocol: 'pg-sync' });
  const diff = formatDiff({ nairobiResult, pgResult });

  process.stdout.write([
    `scenario=${SCENARIO} runId=${runId} user=${user.username}`,
    `  nairobi: count=${nairobiResult.ids.size} elapsed_ms=${nairobiResult.elapsed_ms}`,
    `  pg-sync: count=${pgResult.ids.size} elapsed_ms=${pgResult.elapsed_ms}`,
    `  in_both=${diff.in_both} only_in_pg=${diff.only_in_pg} only_in_nairobi=${diff.only_in_nairobi}`,
    `  only_in_pg sample: ${diff.only_in_pg_sample.join(', ') || '(none)'}`,
    `  only_in_nairobi sample: ${diff.only_in_nairobi_sample.join(', ') || '(none)'}`,
    '',
  ].join('\n'));

  return { nairobiResult, pgResult, diff };
};

module.exports = {
  SCENARIO,
  collectDocIds,
  formatDiff,
  run,
  runProtocol,
};
