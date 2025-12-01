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

// Get full attachments from postgres for a document
const getAttachmentsFromPostgres = async (docId) => {
  try {
    const result = await db.postgres.query(
      'SELECT name, content_type, digest, length, revpos, data FROM attachments WHERE doc_id = $1',
      [docId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const attachments = {};
    for (const row of result.rows) {
      attachments[row.name] = {
        content_type: row.content_type,
        digest: row.digest,
        length: row.length,
        revpos: row.revpos,
        data: row.data
      };
    }
    return attachments;
  } catch (err) {
    console.error(`Error fetching attachments from postgres for ${docId}:`, err);
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

        // If document has attachment stubs, fetch full attachments from postgres
        if (hasAttachmentStubs(doc)) {
          const attachments = await getAttachmentsFromPostgres(doc._id);
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
