'use strict';

// One virtual user. The parent forks this module (via cli.js) per user and
// receives metrics over IPC.
//
// For unit-testability we keep all the logic in `runClient` and let it
// accept stubbed dependencies (a fake PouchDB constructor, a fake fetch, a
// fake replicate fn, a no-op IPC sender). The child wrapper at the bottom
// of the file plugs the real things in.

const nairobi = require('./protocols/nairobi');
const pgSync = require('./protocols/pg-sync');

const buildLocalPouch = (PouchDB, name) => new PouchDB(name, { adapter: 'memory', auto_compaction: true });

const runSync = async ({ protocol, local, remote, replicateFn, baseUrl, user, fetchFn, since }) => {
  if (protocol === 'nairobi') {
    return nairobi.sync({ remote, local, replicateFn, since });
  }
  if (protocol === 'pg-sync') {
    return pgSync.sync({ local, baseUrl, user, fetchFn });
  }
  throw new Error(`unknown protocol: ${protocol}`);
};

const runClient = async (opts) => {
  const {
    PouchDB,
    fetchFn,
    replicateFn,
    sendMessage,
    spec, // { id, username, password, scenario, protocol, syncs: [{ kind, since? }] }
    baseUrl,
  } = opts;

  const localName = `perf-sync-${spec.id}`;
  const local = buildLocalPouch(PouchDB, localName);
  const remote = spec.protocol === 'nairobi'
    ? nairobi.makeRemote(PouchDB, baseUrl, { username: spec.username, password: spec.password })
    : null;

  const results = [];
  for (let i = 0; i < spec.syncs.length; i++) {
    const syncCfg = spec.syncs[i];
    let row;
    try {
      const out = await runSync({
        protocol: spec.protocol,
        local,
        remote,
        replicateFn,
        baseUrl,
        user: { username: spec.username, password: spec.password },
        fetchFn,
        since: syncCfg.since,
      });
      row = {
        scenario: spec.scenario,
        protocol: spec.protocol,
        user_id: spec.id,
        sync_index: i,
        kind: syncCfg.kind,
        docs_pulled: out.docs_pulled,
        docs_pushed: out.docs_pushed,
        elapsed_ms: out.elapsed_ms,
        error: '',
      };
    } catch (err) {
      row = {
        scenario: spec.scenario,
        protocol: spec.protocol,
        user_id: spec.id,
        sync_index: i,
        kind: syncCfg.kind,
        docs_pulled: 0,
        docs_pushed: 0,
        elapsed_ms: 0,
        error: err && err.message ? err.message : String(err),
      };
    }
    sendMessage({ type: 'metric', row });
    results.push(row);
  }
  sendMessage({ type: 'done', user_id: spec.id });
  return results;
};

module.exports = {
  buildLocalPouch,
  runClient,
  runSync,
};

// Child-process entrypoint. Invoked when the file is run directly via
// `node tests/perf-sync/lib/client.js`. Real CHT clients use the global
// fetch (Node 22+) and the pouchdb-adapter-memory module.
if (require.main === module) {
  /* istanbul ignore next */
  (async () => {
    const PouchDB = require('pouchdb');
    PouchDB.plugin(require('pouchdb-adapter-memory'));
    const specJson = process.env.PERF_SYNC_SPEC || process.argv[2];
    if (!specJson) {
      process.stderr.write('client: missing spec on argv\n');
      process.exit(1);
    }
    const spec = JSON.parse(specJson);
    const baseUrl = process.env.PERF_SYNC_BASE_URL || 'http://localhost:5988';
    const sendMessage = (msg) => {
      if (typeof process.send === 'function') {
        process.send(msg);
      } else {
        process.stdout.write(JSON.stringify(msg) + '\n');
      }
    };
    try {
      await runClient({
        PouchDB,
        fetchFn: globalThis.fetch,
        replicateFn: PouchDB.replicate.bind(PouchDB),
        sendMessage,
        spec,
        baseUrl,
      });
      process.exit(0);
    } catch (err) {
      sendMessage({ type: 'fatal', error: err && err.message ? err.message : String(err) });
      process.exit(1);
    }
  })();
}
