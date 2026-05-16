const pgPool = require('./pg-pool');

// Authorization rule (PoC): a user is authorized for a document when the
// user's contact ID is the doc's `subject`, or appears in the `lineage` of
// the contact named by `subject`. See PROJECT.md "Authorization in the PoC".
const SELECT_SQL = `
  SELECT md.doc, md.seq, md.deleted
  FROM medic_documents md
  LEFT JOIN contacts c ON c.id = md.subject
  WHERE md.seq > $1
    AND (md.subject = $2 OR $2 = ANY(c.lineage))
  ORDER BY md.seq ASC
`;

const MAX_SEQ_SQL = `SELECT COALESCE(MAX(seq), 0) AS last_seq FROM medic_documents`;

const normalizeSince = (since) => {
  const n = Number(since);
  if (!Number.isFinite(n) || n < 0) {
    return 0;
  }
  return Math.floor(n);
};

// PoC authorization scope: the user's "place" — facility_id on the
// user-settings doc — is the root of their authorized subject set
// (the place itself + every contact whose lineage contains it). Using
// `contact_id` (the user's own person doc) would only authorize the
// user for themselves; the place is what brings in the household and
// patient descendants.
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

const getMaxSeq = async () => {
  const result = await pgPool.query(MAX_SEQ_SQL);
  const row = result?.rows?.[0];
  return row ? Number(row.last_seq) : 0;
};

/**
 * Fetch docs the user is authorized for with seq greater than `since`.
 *
 * @param {Object} userCtx - the calling user's session context
 * @param {number|string} since - the postgres seq cursor (0 = initial sync)
 * @returns {Promise<{docs: Object[], last_seq: number}>}
 */
const getDocs = async (userCtx, since) => {
  const safeSince = normalizeSince(since);
  const placeId = resolveUserPlaceId(userCtx);
  if (!placeId) {
    const lastSeq = Math.max(safeSince, await getMaxSeq());
    return { docs: [], last_seq: lastSeq };
  }

  const result = await pgPool.query(SELECT_SQL, [safeSince, placeId]);
  const rows = result?.rows || [];
  const docs = rows.map(toResponseDoc);
  const last_seq = rows.length
    ? Number(rows[rows.length - 1].seq)
    : Math.max(safeSince, await getMaxSeq());

  return { docs, last_seq };
};

module.exports = {
  getDocs,
  _resolveUserPlaceId: resolveUserPlaceId,
};
