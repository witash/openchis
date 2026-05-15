'use strict';

// Initial-vs-ongoing scenario: warm a fraction of users with an initial sync,
// then run a second sync round across everyone. Cold users do another
// initial; warm ones see only the delta. Reported separately.

const runner = require('../lib/runner');
const setup = require('../lib/setup');
const { MetricsBuffer, formatSummaryLine } = require('../lib/metrics');

const SCENARIO = 'initial-vs-ongoing';

const DEFAULT_CHW_PASSWORD = 'password';

const splitWarmed = ({ userCount, warmedFraction }) => {
  const warmed = Math.floor(userCount * warmedFraction);
  return { warmed, cold: userCount - warmed };
};

const buildSpecs = ({ runId, userCount, protocol, warmedFraction, password = DEFAULT_CHW_PASSWORD }) => {
  const { warmed } = splitWarmed({ userCount, warmedFraction });
  const specs = [];
  for (let i = 0; i < userCount; i++) {
    const username = `perf-chw-${runId}-${i}`;
    const syncs = i < warmed
      ? [{ kind: 'initial' }, { kind: 'ongoing' }]
      : [{ kind: 'initial' }];
    specs.push({
      id: username,
      username,
      password,
      scenario: SCENARIO,
      protocol,
      syncs,
    });
  }
  return specs;
};

const run = async ({ baseUrl, admin, userCount, runId, protocols, warmedFraction, runSetupFn }) => {
  const buffer = new MetricsBuffer();
  const doSetup = runSetupFn || setup.runSetup;
  await doSetup({ baseUrl, admin, userCount, runId });
  for (const protocol of protocols) {
    const specs = buildSpecs({ runId, userCount, protocol, warmedFraction });
    await runner.runAll(specs, baseUrl, buffer);
    const csvFile = runner.csvPath(SCENARIO, protocol);
    const slice = new MetricsBuffer();
    slice.rows = buffer.rows.filter((r) => r.protocol === protocol);
    runner.writeCsv(csvFile, slice);
    process.stdout.write(`initial-vs-ongoing: CSV written to ${csvFile}\n`);
  }
  // Final report: split by kind so the initial-vs-ongoing comparison is clear.
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
      process.stdout.write('  ' + formatSummaryLine(summary) + '\n');
    }
  }
  return buffer;
};

module.exports = {
  SCENARIO,
  DEFAULT_CHW_PASSWORD,
  buildSpecs,
  run,
  splitWarmed,
};
