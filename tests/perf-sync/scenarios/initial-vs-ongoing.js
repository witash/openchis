'use strict';

// Initial-vs-ongoing scenario: N users, each running TWO consecutive syncs.
// The first sync uses `since=0`; the second reads `_local/perf-pg-sync-state`
// (which the protocol driver wrote at the end of sync #1) and asks for
// `since=last_seq`. With no new docs written between the two calls, the
// second response must be 0 docs — that proves the cursor round-trip works.
//
// `runClient` in lib/client.js already shares one PouchDB across the
// entries in `spec.syncs`, so the `_local/perf-pg-sync-state` doc persists
// between iterations without any extra plumbing.

const runner = require('../lib/runner');
const setup = require('../lib/setup');
const { MetricsBuffer } = require('../lib/metrics');

const SCENARIO = 'initial-vs-ongoing';
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
      syncs: [{ kind: 'initial' }, { kind: 'ongoing' }],
    });
  }
  return specs;
};

const summarize = (buffer, scenario, protocol, userCount) => {
  const rows = buffer.rows;
  const errors = rows.filter((r) => r.error).length;
  const initialRows = rows.filter((r) => r.kind === 'initial');
  const ongoingRows = rows.filter((r) => r.kind === 'ongoing');
  const initialDocs = initialRows.reduce((a, r) => a + Number(r.docs_pulled || 0), 0);
  const ongoingDocs = ongoingRows.reduce((a, r) => a + Number(r.docs_pulled || 0), 0);
  return `scenario=${scenario} protocol=${protocol} users=${userCount} `
    + `initial_docs=${initialDocs} ongoing_docs=${ongoingDocs} errors=${errors}`;
};

const run = async ({ baseUrl, admin, userCount, runId, protocol, runSetupFn }) => {
  const buffer = new MetricsBuffer();
  const doSetup = runSetupFn || setup.runSetup;
  await doSetup({ baseUrl, admin, userCount, runId });
  const specs = buildSpecs({ runId, userCount, protocol });
  await runner.runAll(specs, baseUrl, buffer);
  const csvFile = runner.csvPath(SCENARIO, protocol);
  runner.writeCsv(csvFile, buffer);
  process.stdout.write(`${SCENARIO}: CSV written to ${csvFile}\n`);
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
