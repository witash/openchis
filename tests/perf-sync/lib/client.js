'use strict';

// One virtual user, in-process. Builds a memory PouchDB, invokes the
// pg-sync driver, and emits a metric row.

const pgSync = require('./protocols/pg-sync');

const buildLocalPouch = (PouchDB, name) => new PouchDB(name, { adapter: 'memory', auto_compaction: true });

const runSync = async ({ protocol, local, baseUrl, user, fetchFn }) => {
  if (protocol !== 'pg-sync') {
    throw new Error(`unknown protocol: ${protocol}`);
  }
  return pgSync.sync({ local, baseUrl, user, fetchFn });
};

const runClient = async (opts) => {
  const {
    PouchDB,
    fetchFn,
    sendMessage,
    spec, // { id, username, password, scenario, protocol, syncs: [{ kind }] }
    baseUrl,
  } = opts;

  const localName = `perf-sync-${spec.id}`;
  const local = buildLocalPouch(PouchDB, localName);

  const results = [];
  try {
    for (let i = 0; i < spec.syncs.length; i++) {
      const syncCfg = spec.syncs[i];
      let row;
      try {
        const out = await runSync({
          protocol: spec.protocol,
          local,
          baseUrl,
          user: { username: spec.username, password: spec.password },
          fetchFn,
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
