'use strict';

// Baseline scenario: N users, one initial sync each (push then pull).

const runner = require('../lib/runner');
const setup = require('../lib/setup');
const { MetricsBuffer, summarizeElapsed } = require('../lib/metrics');

const SCENARIO = 'baseline';

const DEFAULT_CHW_PASSWORD = 'password';

const buildSpecs = ({ runId, userCount, protocol, pendingUploads, contactIds, password = DEFAULT_CHW_PASSWORD }) => {
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
      pendingUploads: pendingUploads || 0,
      contactId: contactIds && contactIds.get(username),
      runId,
      userIdx: i,
    });
  }
  return specs;
};

const summarize = (buffer, scenario, protocol, userCount) => {
  const rows = buffer.rows;
  const errors = rows.filter((r) => r.error).length;
  const docsPulled = rows.reduce((a, r) => a + (Number(r.docs_pulled) || 0), 0);
  const docsPushed = rows.reduce((a, r) => a + (Number(r.docs_pushed) || 0), 0);
  const elapsed = summarizeElapsed(rows.map((r) => r.elapsed_ms));
  const pushElapsed = summarizeElapsed(rows.map((r) => r.push_ms));
  const pullElapsed = summarizeElapsed(rows.map((r) => r.pull_ms));
  return `scenario=${scenario} protocol=${protocol} users=${userCount} `
    + `docs_pulled=${docsPulled} docs_pushed=${docsPushed} errors=${errors} `
    + `elapsed_ms=[p50=${elapsed.p50_ms} p95=${elapsed.p95_ms} max=${elapsed.max_ms}] `
    + `push_ms=[p50=${pushElapsed.p50_ms} p95=${pushElapsed.p95_ms} max=${pushElapsed.max_ms}] `
    + `pull_ms=[p50=${pullElapsed.p50_ms} p95=${pullElapsed.p95_ms} max=${pullElapsed.max_ms}]`;
};

const run = async ({ baseUrl, admin, userCount, runId, protocol, pendingUploads, runSetupFn, fetchUserContactMapFn }) => {
  const buffer = new MetricsBuffer();
  const doSetup = runSetupFn || setup.runSetup;
  const doContactMap = fetchUserContactMapFn || setup.fetchUserContactMap;
  const setupResult = await doSetup({ baseUrl, admin, userCount, runId });
  const contactIds = pendingUploads > 0
    ? await doContactMap({ baseUrl, admin, usernames: setupResult.usernames })
    : new Map();
  const specs = buildSpecs({ runId, userCount, protocol, pendingUploads, contactIds });
  await runner.runAll(specs, baseUrl, buffer);
  const csvFile = runner.csvPath(SCENARIO, protocol, runId);
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
