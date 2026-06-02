'use strict';

// Initial-vs-ongoing scenario: N users, each running TWO consecutive syncs.
//
// nairobi is cursor-based: sync #1 does the initial get-ids, sync #2 asks for
// the delta and should be visibly faster. pg-sync on this branch is
// full-snapshot — /api/v1/pg-sync has no server cursor, so the second pull
// re-pulls the whole authorized set (ongoing_docs ~= initial_docs). The push
// side still differs between the two syncs: the seeded pending uploads go up
// on sync #1, and sync #2 has nothing new to push (ongoing_pushed = 0) because
// the push checkpoint advances past the docs pulled in sync #1.
//
// `runClient` in lib/client.js shares one PouchDB across the entries in
// `spec.syncs`, so the populated allDocs (nairobi) and the push checkpoint
// (`local.__pgPushSince`, pg-sync) both persist between iterations.

const runner = require('../lib/runner');
const setup = require('../lib/setup');
const { MetricsBuffer, summarizeElapsed } = require('../lib/metrics');

const SCENARIO = 'initial-vs-ongoing';
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
      syncs: [{ kind: 'initial' }, { kind: 'ongoing' }],
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
  const initialRows = rows.filter((r) => r.kind === 'initial');
  const ongoingRows = rows.filter((r) => r.kind === 'ongoing');
  const initialDocs = initialRows.reduce((a, r) => a + Number(r.docs_pulled || 0), 0);
  const ongoingDocs = ongoingRows.reduce((a, r) => a + Number(r.docs_pulled || 0), 0);
  const initialPushed = initialRows.reduce((a, r) => a + Number(r.docs_pushed || 0), 0);
  const ongoingPushed = ongoingRows.reduce((a, r) => a + Number(r.docs_pushed || 0), 0);
  const initialElapsed = summarizeElapsed(initialRows.map((r) => r.elapsed_ms));
  const ongoingElapsed = summarizeElapsed(ongoingRows.map((r) => r.elapsed_ms));
  return `scenario=${scenario} protocol=${protocol} users=${userCount} `
    + `initial_docs=${initialDocs} initial_pushed=${initialPushed} `
    + `ongoing_docs=${ongoingDocs} ongoing_pushed=${ongoingPushed} errors=${errors} `
    + `initial_ms=[p50=${initialElapsed.p50_ms} p95=${initialElapsed.p95_ms} max=${initialElapsed.max_ms}] `
    + `ongoing_ms=[p50=${ongoingElapsed.p50_ms} p95=${ongoingElapsed.p95_ms} max=${ongoingElapsed.max_ms}]`;
};

const run = async ({
  baseUrl, admin, userCount, maxConcurrentUsers, runId, protocol, pendingUploads,
  runSetupFn, fetchUserContactMapFn,
}) => {
  const buffer = new MetricsBuffer();
  const doSetup = runSetupFn || setup.runSetup;
  const doContactMap = fetchUserContactMapFn || setup.fetchUserContactMap;
  const setupResult = await doSetup({ baseUrl, admin, userCount, runId });
  const contactIds = pendingUploads > 0
    ? await doContactMap({ baseUrl, admin, usernames: setupResult.usernames })
    : new Map();
  const specs = buildSpecs({ runId, userCount, protocol, pendingUploads, contactIds });
  await runner.runAll(specs, baseUrl, buffer, { maxConcurrent: maxConcurrentUsers });
  const csvFile = runner.csvPath(SCENARIO, protocol, runId);
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
