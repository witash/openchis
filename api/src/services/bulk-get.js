const authorization = require('./authorization');
const db = require('../db');
const _ = require('lodash');

// filters response from CouchDB only to include successfully read and allowed docs
const filterResults = (authorizationContext, result) => {
  return result.results.filter(resultDocs => {
    resultDocs.docs = resultDocs.docs.filter(doc => {
      if (!doc.ok) {
        return false;
      }
      return authorization.allowedDoc(resultDocs.id, authorizationContext, authorization.getViewResults(doc.ok));
    });
    return resultDocs.docs.length;
  });
};

// Check if document has attachment stubs
const hasAttachmentStubs = (doc) => {
  if (!doc._attachments) {
    return false;
  }
  return Object.values(doc._attachments).some(att => att.stub === true);
};

// Get full attachments from CouchDB for a document
const getAttachmentsFromCouchDB = async (id, rev) => {
  try {
    const fullDoc = await db.medic.get(id, {
      rev: rev,
      attachments: true,
      binary: false
    });
    return fullDoc._attachments;
  } catch (err) {
    console.error(`Error fetching attachments from CouchDB for ${id}:`, err);
    return null;
  }
};

// Get documents from postgres
const getDocsFromPostgres = async (docs) => {
  const results = [];

  for (const docRequest of docs) {
    const { id, rev } = docRequest;

    try {
      let query, params;

      if (rev) {
        // Get specific revision
        query = `
          SELECT doc
          FROM medic_documents
          WHERE _id = $1 AND _rev = $2
          LIMIT 1
        `;
        params = [id, rev];
      } else {
        // Get latest revision
        query = `
          SELECT doc
          FROM medic_documents
          WHERE _id = $1
          ORDER BY timestamp DESC
          LIMIT 1
        `;
        params = [id];
      }

      const result = await db.postgres.query(query, params);

      if (result.rows.length > 0) {
        const doc = result.rows[0].doc;

        // If document has attachment stubs, fetch full attachments from CouchDB (temporary fix)
        if (hasAttachmentStubs(doc)) {
          const attachments = await getAttachmentsFromCouchDB(doc._id, doc._rev);
          if (attachments) {
            doc._attachments = attachments;
          }
        }

        results.push({
          id: id,
          docs: [{ ok: doc }]
        });
      } else {
        results.push({
          id: id,
          docs: [{
            error: {
              id: id,
              rev: rev,
              error: 'not_found',
              reason: 'missing'
            }
          }]
        });
      }
    } catch (err) {
      console.error(err);
      results.push({
        id: id,
        docs: [{
          error: {
            id: id,
            rev: rev,
            error: 'internal_server_error',
            reason: err.message
          }
        }]
      });
    }
  }

  return { results };
};

module.exports = {
  // offline users will only receive `doc`+`rev` pairs they are allowed to see
  filterOfflineRequest: (userCtx, query, docs) => {
    let authorizationContext;

    return authorization
      .getAuthorizationContext(userCtx)
      .then(context => {
        authorizationContext = context;
        // Get documents from postgres instead of CouchDB
        return getDocsFromPostgres(docs);
      })
//      .then(result => {
//        result.results = filterResults(authorizationContext, result);
//        return result;
//      });
  },
};
