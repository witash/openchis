const importer = require('./importer');

const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_IDLE_DELAY_MS = 5000;

// Indirection so unit tests can substitute the http client without needing
// `axios` installed. Production callers never set this.
let httpGet = async (url, params) => {

  const axios = require('axios');
  const response = await axios.get(url, { params });
  return response.data;
};

const fetchChanges = (couchUrl, since, batchSize) => httpGet(`${couchUrl}/_changes`, {
  since,
  limit: batchSize,
  include_docs: true,
  feed: 'normal',
});

const buildSource = (couchUrl) => {
  const parsed = new URL(couchUrl);
  return `${parsed.hostname}${parsed.pathname}`;
};

const runOnce = async (deps, options) => {
  const { pool, couchUrl } = deps;
  const { batchSize = DEFAULT_BATCH_SIZE } = options || {};

  const source = buildSource(couchUrl);

  const bootstrapClient = await pool.connect();
  let since;
  try {
    since = await importer.getProgress(bootstrapClient, source);
  } finally {
    bootstrapClient.release();
  }

  const changes = await fetchChanges(couchUrl, since, batchSize);
  if (!changes || !Array.isArray(changes.results)) {
    return { processed: 0, last_seq: since };
  }

  return importer.processBatch(pool, source, changes);
};

let running = false;
const stop = () => {
  running = false;
};

const runForever = async (deps, options) => {
  const { idleDelayMs = DEFAULT_IDLE_DELAY_MS } = options || {};
  running = true;
  while (running) {
    const { processed } = await runOnce(deps, options);
    if (!processed) {
      await new Promise((resolve) => setTimeout(resolve, idleDelayMs));
    }
  }
};

module.exports = {
  buildSource,
  fetchChanges,
  runOnce,
  runForever,
  stop,
  _setHttpGet: (fn) => {
    httpGet = fn;
  },
};
