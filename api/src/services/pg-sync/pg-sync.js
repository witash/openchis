const logger = require('@medic/logger');
const pgPool = require('./pg-pool');

// Authorization (PoC): a user is authorized for a document when
//   - the user's place is the doc's `subject` (or in `c.lineage`), or
//   - the doc has `subject = '_all'` (settings, branding, forms,
//     translations, _design/medic-client), or
//   - the doc has `subject = $2` — the user's user-settings id
//     (`org.couchdb.user:<name>`).
// Returns the full authorized set on every call — no cursor, no seq.
const SELECT_SQL = `
  SELECT md.doc, md.deleted
  FROM documents md
  LEFT JOIN contacts c ON c.id = md.subject
  WHERE md.subject = $1 OR $1 = ANY(c.lineage) OR md.subject = '_all' OR md.subject = $2
`;

const resolveUserPlaceId = (userCtx) => {
  if (!userCtx) {
    return null;
  }
  if (Array.isArray(userCtx.facility_id)) {
    return userCtx.facility_id[0] || null;
  }
  if (userCtx.facility_id) {
    return userCtx.facility_id;
  }
  return userCtx.contact_id || null;
};

const toResponseDoc = (row) => {
  const doc = row.doc || {};
  if (row.deleted && !doc._deleted) {
    return Object.assign({}, doc, { _deleted: true });
  }
  return doc;
};

const getDocs = async (userCtx) => {
  const t0 = Date.now();
  const placeId = resolveUserPlaceId(userCtx);
  const userName = (userCtx && userCtx.name) || 'unknown';
  if (!placeId) {
    logger.info(
      `pg-sync getDocs: user=${userName} n=0 total=${Date.now() - t0}ms skipped=no-place-id`
    );
    return { docs: [] };
  }
  const userSettingsId = userCtx && userCtx.name ? `org.couchdb.user:${userCtx.name}` : '';

  const tSql = Date.now();
  const result = await pgPool.query(SELECT_SQL, [placeId, userSettingsId]);
  const sqlMs = Date.now() - tSql;
  const rows = (result && result.rows) || [];
  const docs = rows.map(toResponseDoc);

  logger.info(
    `pg-sync getDocs: user=${userName} n=${docs.length} `
    + `sql=${sqlMs}ms total=${Date.now() - t0}ms`
  );
  return { docs };
};

module.exports = {
  getDocs,
  _resolveUserPlaceId: resolveUserPlaceId,
};
