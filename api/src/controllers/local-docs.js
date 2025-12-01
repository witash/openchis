const db = require('../db');
const logger = require('@medic/logger');
const serverUtils = require('../server-utils');

/**
 * Handles _local document operations for offline users using postgres
 * _local documents are special CouchDB documents that don't replicate
 * and are used for local state storage (replication checkpoints, etc.)
 */

/**
 * GET /:db/_local/:id
 * Retrieves a local document
 */
const get = async (req, res) => {
  const docId = `_local/${req.params.doc}`;

  try {
    const result = await db.postgres.query(
      'SELECT doc FROM local_documents WHERE _id = $1',
      [docId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'not_found',
        reason: 'missing'
      });
    }

    const doc = result.rows[0].doc;
    logger.debug(`Retrieved local document: ${docId}`);
    return res.json(doc);
  } catch (err) {
    logger.error('Error getting local document: %o', err);
    return serverUtils.serverError(err, req, res);
  }
};

/**
 * PUT /:db/_local/:id
 * Creates or updates a local document
 */
const put = async (req, res) => {
  const docId = `_local/${req.params.doc}`;
  const doc = req.body;

  if (!doc || typeof doc !== 'object') {
    return res.status(400).json({
      error: 'bad_request',
      reason: 'invalid_json'
    });
  }

  try {
    // Ensure _id is set correctly
    doc._id = docId;
    // _local documents always have rev "0-1"
    doc._rev = '0-1';

    const now = Date.now();
    const docJson = JSON.stringify(doc);

    await db.postgres.query(
      'INSERT INTO local_documents (_id, doc, updated_at) VALUES ($1, $2, $3) ON CONFLICT (_id) DO UPDATE SET doc = $2, updated_at = $3',
      [docId, docJson, now]
    );

    logger.debug(`Saved local document: ${docId}`);
    return res.json({
      ok: true,
      id: docId,
      rev: '0-1'
    });
  } catch (err) {
    logger.error('Error saving local document: %o', err);
    return serverUtils.serverError(err, req, res);
  }
};

/**
 * DELETE /:db/_local/:id
 * Deletes a local document
 */
const deleteDoc = async (req, res) => {
  const docId = `_local/${req.params.doc}`;

  try {
    const result = await db.postgres.query(
      'DELETE FROM local_documents WHERE _id = $1',
      [docId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: 'not_found',
        reason: 'missing'
      });
    }

    logger.debug(`Deleted local document: ${docId}`);
    return res.json({
      ok: true,
      id: docId,
      rev: '0-1'
    });
  } catch (err) {
    logger.error('Error deleting local document: %o', err);
    return serverUtils.serverError(err, req, res);
  }
};

module.exports = {
  get,
  put,
  delete: deleteDoc
};
