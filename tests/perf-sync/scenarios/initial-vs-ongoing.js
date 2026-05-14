'use strict';

// Initial-vs-ongoing scenario: warm a fraction of users with an initial sync,
// then run a second sync round across everyone. Cold users do another
// initial; warm ones see only the delta. Reported separately.

const fixtures = require('../lib/fixtures');
const runner = require('../lib/runner');
const { MetricsBuffer } = require('../lib/metrics');
const { UserManager } = require('../lib/user-manager');

const SCENARIO = 'initial-vs-ongoing';

const splitWarmed = ({ userCount, warmedFraction }) => {
  const warmed = Math.floor(userCount * warmedFraction);
  return { warmed, cold: userCount - warmed };
};

const buildSpecs = ({ runId, userCount, userPrefix, protocol, warmedFraction }) => {
  const { warmed } = splitWarmed({ userCount, warmedFraction });
  const specs = [];
  for (let i = 0; i < userCount; i++) {
    const u = fixtures.generateUserSpec({ userIndex: i, runId, userPrefix });
    const syncs = i < warmed
      // Warm: do one initial (recorded), then an ongoing sync.
      ? [{ kind: 'initial' }, { kind: 'ongoing' }]
      // Cold: a single initial.
      : [{ kind: 'initial' }];
    specs.push({
      id: u.username,
      username: u.username,
      password: u.password,
      scenario: SCENARIO,
      protocol,
      syncs,
    });
  }
  return specs;
};

const run = async ({ baseUrl, admin, userCount, userPrefix, runId, protocols, warmedFraction, seed, reportsPerUser, fetchFn }) => {
  const userManager = new UserManager({ baseUrl, admin, fetchFn });
  const buffer = new MetricsBuffer();
  let createdSpecs = [];
  try {
    createdSpecs = [];
    for (let i = 0; i < userCount; i++) {
      const userSpec = fixtures.generateUserSpec({ userIndex: i, runId, userPrefix });
      const f = fixtures.generateUserFixtures({ userIndex: i, runId, seed, reportsPerUser });
      await userManager.createUser({ spec: userSpec, hierarchy: f.hierarchy });
      createdSpecs.push(userSpec);
    }
    for (const protocol of protocols) {
      const specs = buildSpecs({ runId, userCount, userPrefix, protocol, warmedFraction });
      await runner.forkAll(specs, baseUrl, buffer);
      const csvFile = runner.csvPath(SCENARIO, protocol);
      const slice = new MetricsBuffer();
      slice.rows = buffer.rows.filter((r) => r.protocol === protocol);
      runner.writeCsv(csvFile, slice);
      process.stdout.write(`initial-vs-ongoing: CSV written to ${csvFile}\n`);
    }
  } finally {
    if (createdSpecs.length) {
      try {
        await userManager.deleteMany({ specs: createdSpecs });
      } catch (err) {
        process.stderr.write(`initial-vs-ongoing: teardown error: ${err.message}\n`);
      }
    }
  }
  // Final report: split by kind so the initial vs ongoing comparison is clear.
  const byProtocol = buffer.groupBy((r) => r.protocol);
  for (const [protocol, rows] of byProtocol) {
    const byKind = new Map();
    for (const r of rows) {
      if (!byKind.has(r.kind)) {
        byKind.set(r.kind, []);
      }
      byKind.get(r.kind).push(r);
    }
    for (const [kind, kindRows] of byKind) {
      const slice = new MetricsBuffer();
      slice.rows = kindRows;
      const summary = slice.summarize();
      process.stdout.write(`scenario=${SCENARIO} protocol=${protocol} kind=${kind} users=${kindRows.length}\n`);
      process.stdout.write('  ' + require('../lib/metrics').formatSummaryLine(summary) + '\n');
    }
  }
  return buffer;
};

module.exports = {
  SCENARIO,
  buildSpecs,
  run,
  splitWarmed,
};
