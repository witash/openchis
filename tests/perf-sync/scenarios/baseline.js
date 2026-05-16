'use strict';

// Baseline scenario: N users, one initial pg-sync each.

const runner = require('../lib/runner');
const setup = require('../lib/setup');
const { MetricsBuffer } = require('../lib/metrics');

const SCENARIO = 'baseline';

const DEFAULT_CHW_PASSWORD = 'password';

const buildSpecs = ({ runId, userCount, protocol, password = DEFAULT_CHW_PASSWORD }) => {
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

const summarize = (buffer, scenario, protocol, userCount) => {
  const rows = buffer.rows;
  const errors = rows.filter((r) => r.error).length;
  const docsPulled = rows.reduce((a, r) => a + (Number(r.docs_pulled) || 0), 0);
  const elapsed = rows.reduce((a, r) => a + (Number(r.elapsed_ms) || 0), 0);
  return `scenario=${scenario} protocol=${protocol} users=${userCount} `
    + `elapsed_ms=${elapsed} docs_pulled=${docsPulled} errors=${errors}`;
};

const run = async ({ baseUrl, admin, userCount, runId, protocol, runSetupFn }) => {
  const buffer = new MetricsBuffer();
  const doSetup = runSetupFn || setup.runSetup;
  await doSetup({ baseUrl, admin, userCount, runId });
  const specs = buildSpecs({ runId, userCount, protocol });
  await runner.runAll(specs, baseUrl, buffer);
  const csvFile = runner.csvPath(SCENARIO, protocol);
  runner.writeCsv(csvFile, buffer);
  process.stdout.write(`baseline: CSV written to ${csvFile}\n`);
  process.stdout.write(summarize(buffer, SCENARIO, protocol, userCount) + '\n');
  return buffer;
};

module.exports = {
  SCENARIO,
  DEFAULT_CHW_PASSWORD,
  buildSpecs,
  run,
  summarize,
};
