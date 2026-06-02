'use strict';

// One virtual user, in-process. Builds a memory PouchDB, optionally seeds
// it with pending uploads (mimicking work the CHW did before syncing),
// and then runs push → pull on every sync — the same order as webapp's
// DBSyncService.syncMedic (`to:` first, then `from:`). Each sync emits one
// metric row with both push and pull breakdowns.

const localSeed = require('./local-seed');
const nairobi = require('./protocols/nairobi');
const pgSync = require('./protocols/pg-sync');
const push = require('./protocols/push');

const buildLocalPouch = (PouchDB, name) => new PouchDB(name, { adapter: 'memory', auto_compaction: true });

const pullForProtocol = ({ protocol, local, baseUrl, user, fetchFn }) => {
  if (protocol === 'nairobi') {
    return nairobi.sync({ local, baseUrl, user, fetchFn });
  }
  if (protocol === 'pg-sync') {
    return pgSync.sync({ local, baseUrl, user, fetchFn });
  }
  throw new Error(`unknown protocol: ${protocol}`);
};

// nairobi pushes up to CouchDB via PouchDB replicate.to; pg-sync writes
// straight to Postgres through /api/v1/pg-sync/write, bypassing CouchDB.
const pushForProtocol = ({ protocol, local, remote, baseUrl, user, fetchFn }) => {
  if (protocol === 'pg-sync') {
    return pgSync.push({ local, baseUrl, user, fetchFn });
  }
  if (protocol === 'nairobi') {
    return push.push({ local, remote });
  }
  throw new Error(`unknown protocol: ${protocol}`);
};

// One full webapp-style sync: replicateTo (push) then replicateFrom (pull).
// We capture each direction's error separately so a push failure doesn't
// hide a pull number (and vice versa) — matches webapp's behaviour of
// recording both outcomes in syncMedic.
const runSync = async ({ protocol, local, remote, baseUrl, user, fetchFn }) => {
  const start = Date.now();
  let pushOut = null;
  let pullOut = null;
  let pushErr = null;
  let pullErr = null;

  try {
    pushOut = await pushForProtocol({
      protocol, local, remote, baseUrl, user, fetchFn,
    });
  } catch (err) {
    pushErr = err;
  }

  try {
    pullOut = await pullForProtocol({ protocol, local, baseUrl, user, fetchFn });
  } catch (err) {
    pullErr = err;
  }

  return {
    elapsed_ms: Date.now() - start,
    docs_pushed: (pushOut && pushOut.docs_pushed) || 0,
    docs_pulled: (pullOut && pullOut.docs_pulled) || 0,
    push_ms: (pushOut && pushOut.elapsed_ms) || 0,
    pull_ms: (pullOut && pullOut.elapsed_ms) || 0,
    pushErr,
    pullErr,
  };
};

const formatError = (pushErr, pullErr) => {
  const parts = [];
  if (pushErr) {
    parts.push(`push: ${pushErr && pushErr.message ? pushErr.message : String(pushErr)}`);
  }
  if (pullErr) {
    parts.push(`pull: ${pullErr && pullErr.message ? pullErr.message : String(pullErr)}`);
  }
  return parts.join(' | ');
};

const runClient = async (opts) => {
  const {
    PouchDB,
    fetchFn,
    sendMessage,
    // { id, username, password, scenario, protocol, syncs: [{ kind }],
    //   pendingUploads?, runId?, userIdx?, contactId? }
    spec,
    baseUrl,
    seedFn,
  } = opts;

  const localName = `perf-sync-${spec.id}`;
  const local = buildLocalPouch(PouchDB, localName);
  // Push uses PouchDB's native replicate.to, which needs a remote PouchDB
  // pointed at /medic with the user's credentials. The nairobi pull driver
  // already exports the same remote shape; reuse it for both protocols so
  // there's only one credentialed remote per user.
  const remote = nairobi.makeRemote(PouchDB, baseUrl, { username: spec.username, password: spec.password });

  let seedErr = null;
  if (spec.pendingUploads && spec.pendingUploads > 0 && spec.contactId) {
    try {
      const doSeed = seedFn || localSeed.seedLocalPouch;
      await doSeed({
        local,
        chwId: spec.contactId,
        count: spec.pendingUploads,
        runId: spec.runId,
        userIdx: spec.userIdx,
      });
    } catch (err) {
      seedErr = err;
    }
  }

  const results = [];
  try {
    for (let i = 0; i < spec.syncs.length; i++) {
      const syncCfg = spec.syncs[i];
      let row;
      if (seedErr) {
        row = {
          scenario: spec.scenario,
          protocol: spec.protocol,
          user_id: spec.id,
          sync_index: i,
          kind: syncCfg.kind,
          docs_pulled: 0,
          docs_pushed: 0,
          elapsed_ms: 0,
          push_ms: 0,
          pull_ms: 0,
          error: `local-seed: ${seedErr.message || String(seedErr)}`,
        };
      } else {
        const out = await runSync({
          protocol: spec.protocol,
          local,
          remote,
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
          push_ms: out.push_ms,
          pull_ms: out.pull_ms,
          error: formatError(out.pushErr, out.pullErr),
        };
      }
      sendMessage({ type: 'metric', row });
      results.push(row);
    }
  } finally {
    try {
      await local.destroy();
    } catch { /* best effort */ }
  }
  sendMessage({ type: 'done', user_id: spec.id });
  return results;
};

module.exports = {
  buildLocalPouch,
  formatError,
  pullForProtocol,
  pushForProtocol,
  runClient,
  runSync,
};
