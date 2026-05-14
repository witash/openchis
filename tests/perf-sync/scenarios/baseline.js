'use strict';

// Baseline scenario: each of N users performs one initial sync.
// Measures: how does each protocol fare at fan-out time?

const fixtures = require('../lib/fixtures');
const runner = require('../lib/runner');
const { MetricsBuffer } = require('../lib/metrics');
const { UserManager } = require('../lib/user-manager');

const SCENARIO = 'baseline';

const buildSpecsForProtocol = ({ runId, userCount, userPrefix, protocol, seed }) => {
  const specs = [];
  for (let i = 0; i < userCount; i++) {
    const userSpec = fixtures.generateUserSpec({ userIndex: i, runId, userPrefix });
    specs.push({
      id: userSpec.username,
      username: userSpec.username,
      password: userSpec.password,
      scenario: SCENARIO,
      protocol,
      syncs: [{ kind: 'initial' }],
      seed: seed + i,
    });
  }
  return specs;
};

const setupUsers = async ({ userManager, runId, userCount, userPrefix, seed, reportsPerUser }) => {
  const specs = [];
  const hierarchies = [];
  for (let i = 0; i < userCount; i++) {
    specs.push(fixtures.generateUserSpec({ userIndex: i, runId, userPrefix }));
    const f = fixtures.generateUserFixtures({ userIndex: i, runId, seed, reportsPerUser });
    hierarchies.push(f.hierarchy);
  }
  await userManager.createMany({ specs, hierarchies });
  return specs;
};

const teardownUsers = async ({ userManager, specs }) => {
  if (!specs.length) {
    return;
  }
  try {
    await userManager.deleteMany({ specs });
  } catch (err) {
    process.stderr.write(`baseline: teardown error: ${err.message}\n`);
  }
};

const run = async ({ baseUrl, admin, userCount, userPrefix, runId, protocols, seed, reportsPerUser, fetchFn }) => {
  const userManager = new UserManager({ baseUrl, admin, fetchFn });
  const buffer = new MetricsBuffer();
  let createdSpecs = [];
  try {
    createdSpecs = await setupUsers({ userManager, runId, userCount, userPrefix, seed, reportsPerUser });
    for (const protocol of protocols) {
      const specs = buildSpecsForProtocol({ runId, userCount, userPrefix, protocol, seed });
      await runner.forkAll(specs, baseUrl, buffer);
      const csvFile = runner.csvPath(SCENARIO, protocol);
      const slice = new MetricsBuffer();
      slice.rows = buffer.rows.filter((r) => r.protocol === protocol);
      runner.writeCsv(csvFile, slice);
      process.stdout.write(`baseline: CSV written to ${csvFile}\n`);
    }
  } finally {
    await teardownUsers({ userManager, specs: createdSpecs });
  }
  process.stdout.write(runner.summarize(buffer, SCENARIO) + '\n');
  return buffer;
};

module.exports = {
  SCENARIO,
  buildSpecsForProtocol,
  run,
  setupUsers,
  teardownUsers,
};
