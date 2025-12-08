const auth = require('../auth');
const bulkDocs = require('../services/bulk-docs');
const _ = require('lodash');
const serverUtils = require('../server-utils');
const db = require('../db');
const logger = require('@medic/logger');

const requestError = reason => ({
  error: 'bad_request',
  reason: reason
});

const invalidRequest = req => {
  // error messages copied from CouchDB source
  if (!req.body) {
    return requestError('invalid UTF-8 JSON');
  }

  if (!req.body.docs) {
    return requestError('POST body must include `docs` parameter.');
  }

  if (!_.isArray(req.body.docs)) {
    return requestError('`docs` parameter must be an array.');
  }

  return false;
};

const interceptResponse = (requestDocs, req, res, response) => {
  return bulkDocs.formatResults(requestDocs, req.body.docs, response);
};

const writeDocsToPostgres = async (docs, requestId) => {
  // Validate docs first
  const validDocs = [];
  const results = [];
  const invalidIndices = new Set();

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    const { _id, _rev } = doc;
    if (!_id || !_rev) {
      results[i] = {
        id: _id,
        error: 'bad_request',
        reason: 'Document must have _id and _rev'
      };
      invalidIndices.add(i);
    } else {
      validDocs.push(doc);
    }
  }

  // Batch insert all valid docs
  const batchStart = Date.now();
  try {
    await db.saveDocsToPostgresBatch(validDocs);
    const batchDuration = Date.now() - batchStart;
    logger.info(`[bulk-docs ${requestId}] batch insert: ${validDocs.length} docs in ${batchDuration}ms`);

    // Build success results for valid docs
    let validIdx = 0;
    for (let i = 0; i < docs.length; i++) {
      if (!invalidIndices.has(i)) {
        results[i] = {
          ok: true,
          id: docs[i]._id,
          rev: docs[i]._rev
        };
        validIdx++;
      }
    }
  } catch (err) {
    const batchDuration = Date.now() - batchStart;
    logger.error(`[bulk-docs ${requestId}] batch insert FAILED after ${batchDuration}ms: ${err.message}`);
    // Mark all valid docs as failed
    let validIdx = 0;
    for (let i = 0; i < docs.length; i++) {
      if (!invalidIndices.has(i)) {
        results[i] = {
          id: docs[i]._id,
          error: 'internal_server_error',
          reason: err.message
        };
        validIdx++;
      }
    }
  }

  return results;
};

module.exports = {
  bulkDelete: (req, res, next) => {
    return auth
      .check(req, ['can_edit'])
      .then(userCtx => {
        if (!auth.isOnlineOnly(userCtx)) {
          throw { code: 401, message: 'User is not an admin' };
        }
      })
      .then(() => bulkDocs.bulkDelete(req.body.docs, res, { batchSize: 50}))
      .catch(err => next(err));
  },

  request: async (req, res, next) => {
    const requestStart = Date.now();
    const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const error = invalidRequest(req);
    if (error) {
      res.status(400);
      return res.json(error);
    }

    try {
      const validationDone = Date.now();

      // For postgres sync, skip the expensive CouchDB authorization context loading.
      // Authorization is handled by the changes endpoint filtering by facility_id.
      const docs = req.body.docs;

      const writeStart = Date.now();
      const results = await writeDocsToPostgres(docs, requestId);
      const writeDone = Date.now();

      const responseStart = Date.now();
      res.json(results);
      const responseDone = Date.now();

      const totalDuration = responseDone - requestStart;
      logger.info(`[bulk-docs ${requestId}] TOTAL: ${totalDuration}ms (validation=${validationDone - requestStart}ms, write=${writeDone - writeStart}ms, response=${responseDone - responseStart}ms, docs=${docs.length})`);

      return;
    } catch (err) {
      logger.error(`[bulk-docs ${requestId}] ERROR after ${Date.now() - requestStart}ms: ${err.message}`);
      return serverUtils.serverError(err, req, res);
    }
  }
};

// used for testing
if (process.env.UNIT_TEST_ENV) {
  Object.assign(module.exports, {
    _invalidRequest: invalidRequest,
    _interceptResponse: interceptResponse
  });
}
