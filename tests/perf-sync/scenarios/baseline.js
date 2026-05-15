'use strict';

// Baseline scenario: each of N users performs one initial sync.
// Measures: how does each protocol fare at fan-out time?

const runner = require('../lib/runner');
const setup = require('../lib/setup');
const { MetricsBuffer } = require('../lib/metrics');

const SCENARIO = 'baseline';

const DEFAULT_CHW_PASSWORD = 'password';

const buildSpecsForProtocol = ({ runId, userCount, protocol, password = DEFAULT_CHW_PASSWORD }) => {
  const specs = [];
  for (let i = 0; i < userCount; i++) {
    const username = `perf-chw-${runId}-${i}`;
    specs.push({
      id: username,
      username,
      password,
      scenario: SCENARIO,
      protocol,
      syncs: [{ kind: 'initial' }],
    });
  }
  return specs;
};

const run = async ({ baseUrl, admin, userCount, runId, protocols, runSetupFn }) => {
  const buffer = new MetricsBuffer();
  const doSetup = runSetupFn || setup.runSetup;
  await doSetup({ baseUrl, admin, userCount, runId });
  for (const protocol of protocols) {
    const specs = buildSpecsForProtocol({ runId, userCount, protocol });
    await runner.runAll(specs, baseUrl, buffer);
    const csvFile = runner.csvPath(SCENARIO, protocol);
    const slice = new MetricsBuffer();
    slice.rows = buffer.rows.filter((r) => r.protocol === protocol);
    runner.writeCsv(csvFile, slice);
    process.stdout.write(`baseline: CSV written to ${csvFile}\n`);
  }
  process.stdout.write(runner.summarize(buffer, SCENARIO) + '\n');
  return buffer;
};

module.exports = {
  SCENARIO,
  DEFAULT_CHW_PASSWORD,
  buildSpecsForProtocol,
  run,
};
