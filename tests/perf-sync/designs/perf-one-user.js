// Thin wrapper around test-data-generator's `sample-designs/one-user.js`.
//
// The upstream design produces, per invocation, a single CHW subtree:
//   district_hospital → health_center → [10 households, 1 chw]
// with each household holding 4 person docs (woman, child, infant, patient)
// plus one pregnancy_danger_sign report attached to the woman, and the chw
// holding _users + user-settings + telemetry + 100 tasks.
//
// We override only the CHW's `username` field so the harness can sign in
// by deriving it from (runId, index) without round-tripping CouchDB.
//
// ESM because test-data-generator is ESM. The upstream factory is injected
// via `configure({ upstreamDesign })` rather than imported directly so the
// wrapper isn't tied to a particular relative path between repos —
// `setup.js` resolves it from disk and hands it in.

const config = { userCount: 1, runId: 'default', upstreamDesign: null };

export const configure = (opts = {}) => {
  if (opts.upstreamDesign) {
    config.upstreamDesign = opts.upstreamDesign;
  }
  if (typeof opts.userCount === 'number') {
    config.userCount = opts.userCount;
  }
  if (opts.runId !== undefined) {
    config.runId = String(opts.runId);
  }
  return { ...config };
};

export const peekConfig = () => ({ ...config });

export const chwUsernameFor = (runId, index) => `perf-chw-${runId}-${index}`;

const stampUsername = (designs, runId, userIndex) => {
  const districtHospital = designs.find((d) => d.designId === 'district-hospital');
  if (!districtHospital) {
    throw new Error('perf-one-user: upstream design lacks district-hospital');
  }
  const healthCenter = districtHospital.children
    && districtHospital.children.find((d) => d.designId === 'health-center');
  if (!healthCenter) {
    throw new Error('perf-one-user: upstream design lacks health-center');
  }
  const chw = healthCenter.children && healthCenter.children.find((d) => d.designId === 'chw');
  if (!chw) {
    throw new Error('perf-one-user: upstream design lacks chw');
  }
  const upstreamGetDoc = chw.getDoc;
  chw.getDoc = (ctx) => ({
    ...upstreamGetDoc(ctx),
    username: chwUsernameFor(runId, userIndex),
  });
};

export default (context) => {
  if (!config.upstreamDesign) {
    throw new Error('perf-one-user: configure({ upstreamDesign }) must be called first');
  }
  const out = [];
  for (let i = 0; i < config.userCount; i++) {
    const userSubtree = config.upstreamDesign(context);
    stampUsername(userSubtree, config.runId, i);
    out.push(...userSubtree);
  }
  return out;
};
