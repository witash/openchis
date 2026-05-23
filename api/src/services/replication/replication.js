const logger = require('@medic/logger');
const db = require('../../db');
const authorization = require('./authorization');
const purgedDocs = require('./purged-docs');
const _ = require('lodash');
const replicationLimitLog = require('./replication-limit-log');

const getContext = async (userCtx) => {
  const t0 = Date.now();
  const userName = (userCtx && userCtx.name) || 'unknown';

  const tInfo = Date.now();
  const info = await db.medic.info();
  const infoMs = Date.now() - tInfo;

  const tAuth = Date.now();
  const authContext = await authorization.getAuthorizationContext(userCtx);
  const authCtxMs = Date.now() - tAuth;
  userCtx.subjectsCount = authContext.subjectIds.length;

  const tView = Date.now();
  const docsByReplicationKey = await authorization.getDocsByReplicationKey(authContext);
  const viewMs = Date.now() - tView;

  const tFilter = Date.now();
  const allowedIds = authorization.filterAllowedDocIds(authContext, docsByReplicationKey);
  const filterMs = Date.now() - tFilter;
  userCtx.docsCount = allowedIds.length;

  const tPurge = Date.now();
  const unpurgedIds = await purgedDocs.getUnPurgedIds(userCtx, allowedIds);
  const purgeMs = Date.now() - tPurge;
  userCtx.unpurgedDocsCount = unpurgedIds.length;

  const excludeTasks = { includeTasks: false };
  const warnIds = authorization.filterAllowedDocIds(authContext, docsByReplicationKey, excludeTasks);
  const unpurgedWarnIds = _.intersection(unpurgedIds, warnIds);

  const tLog = Date.now();
  await replicationLimitLog.put(userCtx.name, unpurgedIds.length, allowedIds.length);
  const logMs = Date.now() - tLog;

  logger.info(
    `nairobi getContext: user=${userName} subjects=${userCtx.subjectsCount} `
    + `allowed=${userCtx.docsCount} unpurged=${userCtx.unpurgedDocsCount} `
    + `info=${infoMs}ms auth=${authCtxMs}ms view=${viewMs}ms filter=${filterMs}ms `
    + `purge=${purgeMs}ms limit_log=${logMs}ms total=${Date.now() - t0}ms`
  );

  return {
    docIds: unpurgedIds,
    warnDocIds: unpurgedWarnIds,
    warn: unpurgedWarnIds.length >= replicationLimitLog.DOC_IDS_WARN_LIMIT,
    limit: replicationLimitLog.DOC_IDS_WARN_LIMIT,
    lastSeq: info.update_seq,
  };
};

const getDocIdsRevPairs = async (docIds) => {
  const t0 = Date.now();
  const result = await db.medic.allDocs({ keys: docIds });
  const pairs = result.rows
    .filter(row => row?.value?.rev)
    .map(row => ({ id: row.id, rev: row.value.rev }));
  logger.info(
    `nairobi getDocIdsRevPairs: requested=${docIds.length} returned=${pairs.length} `
    + `total=${Date.now() - t0}ms`
  );
  return pairs;
};

const getDocIdsToDelete = async (userCtx, docIds) => {
  if (!docIds.length) {
    return [];
  }
  const t0 = Date.now();
  const userName = (userCtx && userCtx.name) || 'unknown';

  const tAll = Date.now();
  const allDocs = await db.medic.allDocs({ keys: docIds });
  const allDocsMs = Date.now() - tAll;
  const toDelete = allDocs.rows
    .filter(row => row.error === 'deleted' || row?.value?.deleted)
    .map(row => row.key);

  const tPurge = Date.now();
  const toPurge = await purgedDocs.getPurgedIds(userCtx, docIds, false);
  const purgeMs = Date.now() - tPurge;
  toDelete.push(...toPurge);

  logger.info(
    `nairobi getDocIdsToDelete: user=${userName} requested=${docIds.length} `
    + `deletes=${toDelete.length} all_docs=${allDocsMs}ms purge=${purgeMs}ms `
    + `total=${Date.now() - t0}ms`
  );
  return toDelete;
};

module.exports = {
  getDocIdsRevPairs,
  getContext,
  getDocIdsToDelete,
};
