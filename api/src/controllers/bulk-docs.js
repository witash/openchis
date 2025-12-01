const auth = require('../auth');
const bulkDocs = require('../services/bulk-docs');
const _ = require('lodash');
const serverUtils = require('../server-utils');
const db = require('../db');

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

const writeDocsToPostgres = async (docs) => {
  const results = [];

  for (const doc of docs) {
    try {
      const { _id, _rev } = doc;
      if (!_id || !_rev) {
        results.push({
          id: _id,
          error: 'bad_request',
          reason: 'Document must have _id and _rev'
        });
        continue;
      }

      // Use shared function from db.js - don't fetch from CouchDB since docs already have full attachments
      await db.saveDocToPostgres(doc, { fetchAttachmentsFromCouchDB: false });

      results.push({
        ok: true,
        id: _id,
        rev: _rev
      });
    } catch (err) {
      results.push({
        id: doc._id,
        error: 'internal_server_error',
        reason: err.message
      });
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

  request: (req, res, next) => {
    const error = invalidRequest(req);
    if (error) {
      res.status(400);
      return res.json(error);
    }

    return bulkDocs
      .filterOfflineRequest(req.userCtx, req.body.docs)
      .then(async filteredDocs => {
        // Write to postgres instead of CouchDB
        const results = await writeDocsToPostgres(filteredDocs);
        const formattedResults = bulkDocs.formatResults(req.body.docs, filteredDocs, results);
        return res.json(formattedResults);
      })
      .catch(err => serverUtils.serverError(err, req, res));
  }
};

// used for testing
if (process.env.UNIT_TEST_ENV) {
  Object.assign(module.exports, {
    _invalidRequest: invalidRequest,
    _interceptResponse: interceptResponse
  });
}
