// Thin wrapper around test-data-generator's many-users.js design.
//
// Re-uses the entire CHW subtree shape — district_hospital →
// health_center → household → {patients, chw} plus the chw-supervisor
// sibling, with the chw getting _users + user-settings + telemetry +
// 100 tasks and one pregnancy-danger-sign report — by invoking the
// upstream factory once per virtual user. The only thing we override is
// the CHW's username so the harness can sign in by deriving it from
// (runId, index) without round-tripping CouchDB.
//
// This file is ESM because test-data-generator is ESM. The upstream
// factory is injected via `configure({ upstreamDesign })` rather than
// imported directly so the wrapper isn't tied to a particular relative
// path between repos — `setup.js` resolves it from disk and hands it
// in, and unit tests can swap in a synthetic factory the same way.

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
    throw new Error('perf-many-users: upstream design lacks district-hospital');
  }
  const healthCenter = districtHospital.children
    && districtHospital.children.find((d) => d.designId === 'health-center');
  if (!healthCenter) {
    throw new Error('perf-many-users: upstream design lacks health-center');
  }
  const chw = healthCenter.children && healthCenter.children.find((d) => d.designId === 'chw');
  if (!chw) {
    throw new Error('perf-many-users: upstream design lacks chw');
  }
  const upstreamGetDoc = chw.getDoc;
  chw.getDoc = (ctx) => ({
    ...upstreamGetDoc(ctx),
    username: chwUsernameFor(runId, userIndex),
  });
};

export default (context) => {
  if (!config.upstreamDesign) {
    throw new Error('perf-many-users: configure({ upstreamDesign }) must be called first');
  }
  const out = [];
  for (let i = 0; i < config.userCount; i++) {
    const userSubtree = config.upstreamDesign(context);
    stampUsername(userSubtree, config.runId, i);
    out.push(...userSubtree);
  }
  return out;
};
