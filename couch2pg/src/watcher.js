const axios = require('axios');

const importer = require('./importer');

const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_IDLE_DELAY_MS = 5000;

const fetchChanges = async (couchUrl, since, batchSize) => {
  const url = `${couchUrl}/_changes`;
  const response = await axios.get(url, {
    params: {
      since,
      limit: batchSize,
      include_docs: true,
      feed: 'normal',
    },
  });
  return response.data;
};

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

  const result = await importer.processBatch(pool, source, changes);
  return result;
};

const runForever = async (deps, options) => {
  const { idleDelayMs = DEFAULT_IDLE_DELAY_MS } = options || {};
  // eslint-disable-next-line no-constant-condition
  while (true) {
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
};
