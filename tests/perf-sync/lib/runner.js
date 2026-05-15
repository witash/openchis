'use strict';

// In-process runner: drives N virtual users concurrently with Promise.all.
//
// Previously this forked one child per spec and shipped metrics over IPC.
// Node already gives us all the concurrency we need for the IO-bound sync
// workload, so the fork plumbing was pure overhead — each child paid a
// fresh-process startup tax, a duplicate require graph, and an extra V8
// heap. async/await against the same fetch + PouchDB instances is what
// the equivalent webapp client does.

const fs = require('fs');
const path = require('path');
const { MetricsBuffer, formatSummaryLine } = require('./metrics');

const RESULTS_DIR = path.resolve(__dirname, '..', 'results');

const ensureResultsDir = () => {
  if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
  }
};

const csvPath = (scenario, protocol, ts = Date.now()) => {
  ensureResultsDir();
  return path.join(RESULTS_DIR, `${scenario}-${protocol}-${ts}.csv`);
};

const writeCsv = (filePath, buffer) => {
  fs.writeFileSync(filePath, buffer.toCsv());
  return filePath;
};

// Lazily resolve PouchDB so unit tests can inject a stub without pulling
// in pouchdb-adapter-memory's native cost.
const defaultPouchDB = () => {
  const PouchDB = require('pouchdb');
  if (!PouchDB.__perfSyncMemPluginLoaded) {
    PouchDB.plugin(require('pouchdb-adapter-memory'));
    PouchDB.__perfSyncMemPluginLoaded = true;
  }
  return PouchDB;
};

// Run every spec concurrently. Each spec drives one virtual user via
// runClient (which builds its own in-memory PouchDB, posts metrics into
// `buffer` via the sendMessage callback, and resolves on done).
const runAll = async (specs, baseUrl, buffer, opts = {}) => {
  if (!specs.length) {
    return;
  }
  const runClient = opts.runClient || require('./client').runClient;
  const PouchDB = opts.PouchDB || defaultPouchDB();
  const fetchFn = opts.fetchFn || globalThis.fetch;
  const replicateFn = opts.replicateFn || PouchDB.replicate.bind(PouchDB);
  const sendMessage = (msg) => {
    if (msg && msg.type === 'metric' && msg.row) {
      buffer.add(msg.row);
    }
  };
  await Promise.all(specs.map((spec) => runClient({
    PouchDB,
    fetchFn,
    replicateFn,
    sendMessage,
    spec,
    baseUrl,
  })));
};

const summarize = (buffer, scenario) => {
  const lines = [];
  const groups = buffer.groupBy((r) => r.protocol);
  for (const [protocol, rows] of groups) {
    const inner = new MetricsBuffer();
    inner.rows = rows;
    const summary = inner.summarize();
    lines.push(`scenario=${scenario} protocol=${protocol} users=${rows.length}`);
    lines.push('  ' + formatSummaryLine(summary));
  }
  return lines.join('\n');
};

module.exports = {
  RESULTS_DIR,
  csvPath,
  ensureResultsDir,
  runAll,
  summarize,
  writeCsv,
};
