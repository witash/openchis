// Pending-uploads design — used to seed a CHW's *local* PouchDB with docs
// that haven't been synced upstream yet. Mirrors the shape of
// test-data-generator's pregnancy_danger_sign report so the docs hit the
// same data_record handling on the server when the harness pushes them.
//
// The design factory is intentionally flat (no children) — every doc is a
// data_record owned by the CHW. Docs.createDocs's getParentAssociationData
// picks up doc.contact and stamps the parent relation. test-data-generator
// adds the _id (uuid) and `contact: { _id: <chw> }`, fields.patient_uuid
// without us touching that logic.

const config = { chwId: null, count: 0, runId: 'default', userIdx: 0 };

export const configure = (opts = {}) => {
  if (opts.chwId !== undefined) {
    config.chwId = opts.chwId;
  }
  if (typeof opts.count === 'number') {
    config.count = opts.count;
  }
  if (opts.runId !== undefined) {
    config.runId = String(opts.runId);
  }
  if (typeof opts.userIdx === 'number') {
    config.userIdx = opts.userIdx;
  }
  return { ...config };
};

export const peekConfig = () => ({ ...config });

const getPendingDangerSign = () => ({
  type: 'data_record',
  form: 'pregnancy_danger_sign',
  content_type: 'xml',
  from: `+254700${String(config.userIdx).padStart(6, '0')}`,
  reported_date: Date.now(),
  // doc.contact is honoured by Docs.getParentAssociationData when type is
  // data_record. We set `type: 'person'` so getPatientPlaceIdentifiers picks
  // the patient_uuid branch (vs. place_uuid).
  contact: { _id: config.chwId, type: 'person' },
  fields: {
    patient_age_in_years: 28,
    patient_name: 'perf-patient',
    danger_signs: {
      vaginal_bleeding: 'yes',
      r_danger_sign_present: 'yes',
    },
  },
});

export default () => {
  if (!config.chwId) {
    throw new Error('perf-pending-uploads: configure({ chwId }) must be called first');
  }
  if (!config.count) {
    return [];
  }
  return [
    {
      designId: 'perf-pending-upload',
      amount: config.count,
      getDoc: () => getPendingDangerSign(),
    },
  ];
};
