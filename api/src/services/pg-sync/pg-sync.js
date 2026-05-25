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
  const placeId = resolveUserPlaceId(userCtx);
  if (!placeId) {
    return { docs: [] };
  }
  const userSettingsId = userCtx && userCtx.name ? `org.couchdb.user:${userCtx.name}` : '';
  const result = await pgPool.query(SELECT_SQL, [placeId, userSettingsId]);
  const rows = (result && result.rows) || [];
  return { docs: rows.map(toResponseDoc) };
};

module.exports = {
  getDocs,
  _resolveUserPlaceId: resolveUserPlaceId,
};
