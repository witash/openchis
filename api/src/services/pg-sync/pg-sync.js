const logger = require('@medic/logger');
const db = require('../../db');
const pgPool = require('./pg-pool');

// Authorization rule (PoC): a user is authorized for a document when
//   - the user's place is the doc's `subject` (or in `c.lineage`), or
//   - the doc has `subject = '_all'` — the sentinel the transform stamps
//     onto docs that every user can replicate (settings, branding, forms,
//     translations, _design/medic-client). Mirrors webapp's nairobi
//     authorization which seeds `subjectIds` with `_all`, or
//   - the doc has `subject = $3` — the user's user-settings id
//     (`org.couchdb.user:<name>`). Tasks (and other per-user docs) are
//     keyed by this id; the view does the same via the user's
//     `subjectIds`.
// See PROJECT.md "Authorization in the PoC".
const SELECT_SQL = `
  SELECT md.doc, md.seq, md.deleted
  FROM medic_documents md
  LEFT JOIN contacts c ON c.id = md.subject
  WHERE md.seq > $1
    AND (md.subject = $2 OR $2 = ANY(c.lineage) OR md.subject = '_all' OR md.subject = $3)
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

const hasAttachmentStub = (doc) => {
  if (!doc || !doc._attachments) {
    return false;
  }
  for (const name of Object.keys(doc._attachments)) {
    const att = doc._attachments[name];
    if (att && att.stub) {
      return true;
    }
  }
  return false;
};

// The mirror stores the doc body as it arrives on the changes feed, where
// `_attachments` is a stubs-only metadata block. PouchDB on the client side
// rejects `bulkDocs(new_edits: false)` on a stubbed doc when it can't find
// the underlying binary locally, so we re-hydrate attachments from CouchDB
// before returning. Mirrors what nairobi's `_bulk_get?attachments=true`
// call already does for its clients.
const resolveAttachments = async (docs, { medicDb = db.medic } = {}) => {
  const stubIndices = [];
  const bulkGetSpec = [];
  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    if (!doc || doc._deleted) {
      continue;
    }
    if (hasAttachmentStub(doc)) {
      stubIndices.push(i);
      bulkGetSpec.push({ id: doc._id, rev: doc._rev });
    }
  }
  if (!stubIndices.length) {
    return docs;
  }

  const response = await medicDb.bulkGet({ docs: bulkGetSpec, attachments: true, revs: true });
  const resultsById = new Map();
  for (const r of (response && response.results) || []) {
    const ok = r && r.docs && r.docs[0] && r.docs[0].ok;
    if (ok) {
      resultsById.set(r.id, ok);
    }
  }
  for (const idx of stubIndices) {
    const inline = resultsById.get(docs[idx]._id);
    if (inline) {
      docs[idx] = inline;
    }
  }
  return docs;
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
  const t0 = Date.now();
  const safeSince = normalizeSince(since);
  const placeId = resolveUserPlaceId(userCtx);
  const userName = (userCtx && userCtx.name) || 'unknown';
  if (!placeId) {
    const tMax = Date.now();
    const lastSeq = Math.max(safeSince, await getMaxSeq());
    logger.info(
      `pg-sync getDocs: user=${userName} since=${safeSince} n=0 `
      + `max_seq=${Date.now() - tMax}ms total=${Date.now() - t0}ms skipped=no-place-id`
    );
    return { docs: [], last_seq: lastSeq };
  }
  const userSettingsId = userCtx && userCtx.name ? `org.couchdb.user:${userCtx.name}` : '';

  const tSql = Date.now();
  const result = await pgPool.query(SELECT_SQL, [safeSince, placeId, userSettingsId]);
  const sqlMs = Date.now() - tSql;
  const rows = result?.rows || [];
  const docs = rows.map(toResponseDoc);

  const tAtt = Date.now();
  const resolved = await resolveAttachments(docs);
  const attachmentsMs = Date.now() - tAtt;

  let maxSeqMs = 0;
  let last_seq;
  if (rows.length) {
    last_seq = Number(rows[rows.length - 1].seq);
  } else {
    const tMax = Date.now();
    last_seq = Math.max(safeSince, await getMaxSeq());
    maxSeqMs = Date.now() - tMax;
  }

  logger.info(
    `pg-sync getDocs: user=${userName} since=${safeSince} n=${resolved.length} `
    + `sql=${sqlMs}ms attachments=${attachmentsMs}ms max_seq=${maxSeqMs}ms `
    + `total=${Date.now() - t0}ms`
  );
  return { docs: resolved, last_seq };
};

module.exports = {
  getDocs,
  _resolveUserPlaceId: resolveUserPlaceId,
  _resolveAttachments: resolveAttachments,
  _hasAttachmentStub: hasAttachmentStub,
};
