const auth = require('../auth');
const bulkDocs = require('../services/bulk-docs');
const _ = require('lodash');
const serverUtils = require('../server-utils');
const db = require('../db');
const { getSubject } = require('../services/subject-extractor');

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

const CONTACT_TYPES = ['contact', 'person', 'health_center', 'district_hospital', 'clinic'];

const isContactType = (doc) => {
  return doc.type && CONTACT_TYPES.includes(doc.type);
};

const extractParentId = (doc) => {
  if (!doc.parent) {
    return null;
  }
  // Parent can be either a string (id) or an object with _id
  return typeof doc.parent === 'string' ? doc.parent : doc.parent._id;
};

const insertContactIfNeeded = async (doc) => {
  if (!isContactType(doc)) {
    return;
  }

  const parentId = extractParentId(doc);

  try {
    await db.postgres.query(
      'INSERT INTO contacts (id, type, parent) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET type = $2, parent = $3',
      [doc._id, doc.type, parentId]
    );
  } catch (err) {
    console.error(`Error inserting contact ${doc._id}:`, err);
    // Don't fail the whole operation if contact insert fails
  }
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

      const timestamp = Date.now();
      const docJson = JSON.stringify(doc);
      const subject = getSubject(doc);

      await db.postgres.query(
        'INSERT INTO medic_documents (_id, _rev, timestamp, doc, subject) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (_id, _rev) DO UPDATE SET timestamp = $3, doc = $4, subject = $5',
        [_id, _rev, timestamp, docJson, subject]
      );

      // If this is a contact document, also insert into contacts table
      await insertContactIfNeeded(doc);

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
