'use strict';

// In-process runner for Phase A: drives N virtual users concurrently and
// writes the collected rows out as one CSV per (scenario, protocol).

const fs = require('fs');
const path = require('path');
const RESULTS_DIR = path.resolve(__dirname, '..', 'results');

const ensureResultsDir = () => {
  if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
  }
};

const csvPath = (scenario, protocol, label) => {
  ensureResultsDir();
  const tag = label === undefined || label === null || label === '' ? String(Date.now()) : String(label);
  return path.join(RESULTS_DIR, `${scenario}-${protocol}-${tag}.csv`);
};

const writeCsv = (filePath, buffer) => {
  fs.writeFileSync(filePath, buffer.toCsv());
  return filePath;
};

const defaultPouchDB = () => {
  const PouchDB = require('pouchdb');
  if (!PouchDB.__perfSyncMemPluginLoaded) {
    PouchDB.plugin(require('pouchdb-adapter-memory'));
    PouchDB.__perfSyncMemPluginLoaded = true;
  }
  return PouchDB;
};

const runAll = async (specs, baseUrl, buffer, opts = {}) => {
  if (!specs.length) {
    return;
  }
  const runClient = opts.runClient || require('./client').runClient;
  const PouchDB = opts.PouchDB || defaultPouchDB();
  const fetchFn = opts.fetchFn || globalThis.fetch;
  const sendMessage = (msg) => {
    if (msg && msg.type === 'metric' && msg.row) {
      buffer.add(msg.row);
    }
  };
  await Promise.all(specs.map((spec) => runClient({
    PouchDB,
    fetchFn,
    sendMessage,
    spec,
    baseUrl,
  })));
};

module.exports = {
  RESULTS_DIR,
  csvPath,
  ensureResultsDir,
  runAll,
  writeCsv,
};
