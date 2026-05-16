'use strict';

// One virtual user, in-process. Builds a memory PouchDB, invokes the
// configured protocol driver, and emits a metric row.

const nairobi = require('./protocols/nairobi');
const pgSync = require('./protocols/pg-sync');

const buildLocalPouch = (PouchDB, name) => new PouchDB(name, { adapter: 'memory', auto_compaction: true });

const runSync = async ({ protocol, local, remote, replicateFn, baseUrl, user, fetchFn, since }) => {
  if (protocol === 'nairobi') {
    return nairobi.sync({ remote, local, replicateFn, baseUrl, user, fetchFn, since });
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
  try {
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
  } finally {
    try {
      await local.destroy();
    } catch (_destroyErr) { /* best effort */ }
  }
  sendMessage({ type: 'done', user_id: spec.id });
  return results;
};

module.exports = {
  buildLocalPouch,
  runClient,
  runSync,
};
