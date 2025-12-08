const db = require('../db');
const serverUtils = require('../server-utils');
const logger = require('@medic/logger');
const environment = require('@medic/environment');

// Postgres-backed view queries
// Each function corresponds to a CouchDB map-reduce view
// Views not defined here will fallback to CouchDB
const views = {
  // SQL views can be added here later
  // For now, all views fallback to CouchDB
};

// Fallback to CouchDB for views not implemented in postgres
const queryCouchDBView = async (viewName, query) => {
  const options = { ...query };

  // Convert string booleans to actual booleans
  if (options.include_docs === 'true') {
    options.include_docs = true;
  }
  if (options.include_docs === 'false') {
    options.include_docs = false;
  }

  return db.medic.query(`medic-client/${viewName}`, options);
};

module.exports = {
  request: async (req, res) => {
    const viewName = req.params.viewName;
    const viewFunction = views[viewName];

    logger.debug(`View request: ${viewName}, query: ${JSON.stringify(req.parsedQuery)}`);

    try {
      let result;
      if (viewFunction) {
        // Use postgres-backed view
        result = await viewFunction(req.userCtx, req.parsedQuery, req.body);
        logger.debug(`View ${viewName} (postgres) returned ${result.rows.length} rows`);
      } else {
        // Fallback to CouchDB
        result = await queryCouchDBView(viewName, req.parsedQuery);
        logger.debug(`View ${viewName} (couchdb) returned ${result.rows.length} rows`);
      }
      return res.json(result);
    } catch (err) {
      logger.error(`View ${viewName} error: %o`, err);
      return serverUtils.serverError(err, req, res);
    }
  }
};
