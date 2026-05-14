'use strict';

// Deterministic per-user fixtures for the perf harness.
//
// Goal: shapes that match the canonical CHT subject-derivation rules so the
// harness exercises both protocols against representative documents. The
// source of truth for those rules is
// ddocs/medic-db/medic/nouveau/docs_by_replication_key/index.js; the
// `deriveSubject` helper below mirrors the data_record + contact cases of
// that view so tests can assert that generated docs are authorized to the
// expected contact.

const FORMS = ['pregnancy', 'pregnancy_visit', 'delivery', 'immunisation_visit'];

// Tiny seeded PRNG (mulberry32). Stable across Node versions and small enough
// to keep deterministic seeding self-contained — pulling in a dep for one
// scalar generator is overkill.
const makeRng = (seed) => {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const HEX = '0123456789abcdef';
const uuidish = (rng) => {
  const c = [];
  for (let i = 0; i < 32; i++) {
    c.push(HEX[Math.floor(rng() * 16)]);
  }
  // RFC4122 v4-ish; we only care that the format is stable & looks like a
  // CHT uuid. We are not generating real cryptographic uuids.
  c[12] = '4';
  c[16] = HEX[(parseInt(c[16], 16) & 0x3) | 0x8];
  return `${c.slice(0, 8).join('')}-${c.slice(8, 12).join('')}-${c.slice(12, 16).join('')}-${c.slice(16, 20).join('')}-${c.slice(20).join('')}`;
};

// Mirrors the data_record / contact branches of
// ddocs/medic-db/medic/nouveau/docs_by_replication_key/index.js .
// Returns the subject (authorizing contact id) for a doc.
const deriveSubject = (doc) => {
  if (!doc) {
    return '_unassigned';
  }
  const contactTypes = ['person', 'clinic', 'health_center', 'district_hospital', 'contact'];
  if (contactTypes.includes(doc.type)) {
    return doc._id;
  }
  if (doc.type === 'task') {
    return doc.user || doc.owner || '_unassigned';
  }
  if (doc.type === 'target') {
    return doc.owner || '_unassigned';
  }
  if (doc.type === 'data_record') {
    // Fallback to contact._id if a known registration_not_found / invalid_patient_id error fires.
    if (doc.contact && Array.isArray(doc.errors) && doc.errors.length) {
      for (const err of doc.errors) {
        if (err && (err.code === 'registration_not_found' || err.code === 'invalid_patient_id')) {
          return doc.contact._id;
        }
      }
    }
    const subject = (doc.patient_id || (doc.fields && doc.fields.patient_id)) ||
      (doc.place_id || (doc.fields && doc.fields.place_id)) ||
      (doc.fields && doc.fields.patient_uuid) ||
      (doc.contact && doc.contact._id);
    return subject || '_unassigned';
  }
  if (doc.sms_message) {
    return (doc.contact && doc.contact._id) || '_unassigned';
  }
  if (doc.kujua_message && doc.tasks && doc.tasks[0] && doc.tasks[0].messages && doc.tasks[0].messages[0] &&
      doc.tasks[0].messages[0].contact) {
    return doc.tasks[0].messages[0].contact._id;
  }
  return '_unassigned';
};

const generateUserHierarchy = ({ userIndex, runId, seed }) => {
  const rng = makeRng(seed ^ (userIndex + 1));
  const districtId = `${runId}-dh-${userIndex}`;
  const healthCenterId = `${runId}-hc-${userIndex}`;
  const userContactId = `${runId}-person-${userIndex}`;

  const district = {
    _id: districtId,
    type: 'district_hospital',
    name: `Perf District ${userIndex}`,
    reported_date: 1000 + userIndex,
    parent: '',
  };
  const healthCenter = {
    _id: healthCenterId,
    type: 'health_center',
    name: `Perf HC ${userIndex}`,
    reported_date: 1001 + userIndex,
    parent: { _id: districtId },
  };
  const userContact = {
    _id: userContactId,
    type: 'person',
    name: `Perf User ${userIndex}`,
    phone: `+155500${String(userIndex).padStart(5, '0')}`,
    reported_date: 1002 + userIndex,
    parent: { _id: healthCenterId, parent: { _id: districtId } },
    // attach a deterministic-looking field so we exercise random-shape paths
    perfNonce: Math.floor(rng() * 1e6),
  };

  return {
    district,
    healthCenter,
    userContact,
    contacts: [district, healthCenter, userContact],
  };
};

const generateReports = ({ count, userIndex, runId, hierarchy, seed }) => {
  const rng = makeRng((seed ^ 0x55aa) + userIndex);
  const reports = [];
  for (let i = 0; i < count; i++) {
    const id = `${runId}-rep-${userIndex}-${i}`;
    const form = FORMS[i % FORMS.length];
    const patientUuid = `${runId}-pat-${userIndex}-${i}`;
    const reportedDate = 1700000000000 + (userIndex * 1000) + i;
    reports.push({
      _id: id,
      type: 'data_record',
      form,
      content_type: 'xml',
      reported_date: reportedDate,
      from: hierarchy.userContact.phone,
      contact: {
        _id: hierarchy.userContact._id,
        parent: hierarchy.userContact.parent,
      },
      fields: {
        // patient_uuid is the canonical PoC subject for reports authorized by patient
        patient_uuid: patientUuid,
        patient_age_in_years: 18 + Math.floor(rng() * 40),
        note: `perf-${i}`,
      },
    });
  }
  return reports;
};

const generateUserFixtures = ({ userIndex, runId, seed, reportsPerUser }) => {
  const hierarchy = generateUserHierarchy({ userIndex, runId, seed });
  const reports = generateReports({
    count: reportsPerUser,
    userIndex,
    runId,
    hierarchy,
    seed,
  });
  return { hierarchy, reports };
};

const generateUserSpec = ({ userIndex, runId, userPrefix }) => {
  // The user's CouchDB account; the harness creates this via /api/v1/users.
  const username = `${userPrefix}-${runId}-${userIndex}`;
  return {
    username,
    password: `Pwd-${runId}-${userIndex}-Aa1!`,
    place: null,        // filled in from the hierarchy at create-time
    contact: null,      // filled in from the hierarchy at create-time
    roles: ['chw'],
    type: 'person',
  };
};

module.exports = {
  FORMS,
  deriveSubject,
  generateReports,
  generateUserFixtures,
  generateUserHierarchy,
  generateUserSpec,
  makeRng,
  uuidish,
  _internal: { makeRng, uuidish },
};
