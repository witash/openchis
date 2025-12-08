const utils = require('./utils');
const { setUiStatus } = require('./ui-status');

const INITIAL_REPLICATION_LOG = '_local/initial-replication';
const BATCH_SIZE = 100;

// Read-only types and IDs that should not be replicated to server
const READ_ONLY_TYPES = ['form', 'translations'];
const READ_ONLY_IDS = ['resources', 'branding', 'service-worker-meta', 'zscore-charts', 'settings', 'partners'];

const startInitialReplication = async (localDb) => {
  if (await getReplicationLog(localDb)) {
    return;
  }

  const log = {
    _id: INITIAL_REPLICATION_LOG,
    start_time: Date.now(),
    start_data_usage: getDataUsage(),
  };

  await localDb.put(log);
};

const completeInitialReplication = async (localDb) => {
  const dbSyncEndData = getDataUsage();

  const replicationLog = await getReplicationLog(localDb);
  if (!replicationLog) {
    throw new Error('Invalid replication state: missing replication log');
  }

  replicationLog.complete = true;
  replicationLog.duration =  Date.now() - replicationLog.start_time;
  replicationLog.data_usage = replicationLog.start_data_usage &&
                              dbSyncEndData.app.rx - replicationLog.start_data_usage.app.rx;

  console.info('Initial sync completed successfully in ' + (replicationLog.duration / 1000) + ' seconds');
  if (replicationLog.data_usage) {
    console.info('Initial sync received ' + replicationLog.data_usage + 'B of data');
  }

  await localDb.put(replicationLog);
};

const getDataUsage = () => {
  if (window.medicmobile_android && typeof window.medicmobile_android.getDataUsage === 'function') {
    return JSON.parse(window.medicmobile_android.getDataUsage());
  }
};

const getLocalDocMap = async (localDb) => {
  const response = await localDb.allDocs();
  const localDocMap = {};
  response.rows.forEach(row => localDocMap[row.id] = row.value && row.value.rev);
  return localDocMap;
};

const getChangesBatch = async (sinceTimestamp) => {
  let url = `/api/v1/replication/changes?limit=${BATCH_SIZE}`;
  if (sinceTimestamp) {
    url += `&since=${sinceTimestamp}`;
  }
  return await utils.fetchJSON(url);
};

const downloadDocs = async (localDb) => {
  let currentTimestamp;
  let totalDownloaded = 0;

  setUiStatus('FETCH_INFO', { count: 0, total: '?' });

  while (true) {
    const { docs, last_timestamp } = await getChangesBatch(currentTimestamp);

    if (docs.length === 0) {
      break;
    }

    // Get local docs to filter out ones we already have with same rev
    const localDocMap = await getLocalDocMap(localDb);
    const docsToSave = docs.filter(doc => !localDocMap[doc._id] || localDocMap[doc._id] !== doc._rev);

    if (docsToSave.length > 0) {
      await localDb.bulkDocs(docsToSave, { new_edits: false });
      totalDownloaded += docsToSave.length;
    }

    setUiStatus('FETCH_INFO', { count: totalDownloaded, total: totalDownloaded + (docs.length === BATCH_SIZE ? '+' : '') });

    if (docs.length < BATCH_SIZE) {
      break;
    }

    currentTimestamp = last_timestamp;
  }

  return totalDownloaded;
};

const shouldReplicateDoc = (doc) => {
  if (!doc) {
    return false;
  }
  // Never replicate "purged" documents upwards
  const keys = Object.keys(doc);
  if (keys.length === 4 &&
      keys.includes('_id') &&
      keys.includes('_rev') &&
      keys.includes('_deleted') &&
      keys.includes('purged')) {
    return false;
  }
  // Never replicate design docs
  if (doc._id.indexOf('_design/') === 0) {
    return false;
  }
  // Don't replicate read-only types and IDs
  if (READ_ONLY_TYPES.includes(doc.type)) {
    return false;
  }
  if (READ_ONLY_IDS.includes(doc._id)) {
    return false;
  }
  return true;
};

const replicateToServer = async (localDb, sinceSeq) => {
  // Get local changes since the given sequence
  const changesResult = await localDb.changes({
    since: sinceSeq || 0,
    include_docs: true,
    batch_size: BATCH_SIZE
  });

  // Filter out docs that shouldn't be replicated
  const docsToSend = changesResult.results
    .map(change => change.doc)
    .filter(shouldReplicateDoc);

  if (docsToSend.length === 0) {
    return { docs_written: 0, last_seq: changesResult.last_seq };
  }

  // Send docs to bulk_docs endpoint
  await utils.fetchJSON('/medic/_bulk_docs', {
    method: 'POST',
    body: JSON.stringify({ docs: docsToSend }),
    headers: { 'Content-Type': 'application/json' }
  });

  return { docs_written: docsToSend.length, last_seq: changesResult.last_seq };
};

const writeCheckpointers = async (remoteDb, localDb) => {
  const localInfo = await localDb.info();
  await replicateToServer(localDb, localInfo.update_seq);
};

const replicate = async (remoteDb, localDb) => {
  setUiStatus('LOAD_APP');

  await startInitialReplication(localDb);

  setUiStatus('POLL_REPLICATION');
  await downloadDocs(localDb);
  await writeCheckpointers(remoteDb, localDb);

  await completeInitialReplication(localDb);
};

const getReplicationLog = async (localDb) => {
  try {
    return await localDb.get(INITIAL_REPLICATION_LOG);
  } catch (err) {
    console.warn('Error getting replication log: ', err);
    return null;
  }
};
const isReplicationNeeded = async (localDb, userCtx) => {
  const requiredDocs = [
    '_design/medic-client',
    'settings',
    `org.couchdb.user:${userCtx.name}`,
  ];
  const results = await localDb.allDocs({ keys: requiredDocs });
  const missingDocs = results.rows.some(row => row.error);

  if (missingDocs) {
    return true;
  }

  const replicationLog = await getReplicationLog(localDb);
  // new user who has started replicating, but did not complete
  if (replicationLog && !replicationLog.complete) {
    return true;
  }

  return false;
};

module.exports = {
  isReplicationNeeded,
  replicate,
};
