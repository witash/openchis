'use strict';

// Parent-process runner: forks N child processes (one per virtual user),
// collects metric IPC messages into a MetricsBuffer, writes the CSV, and
// prints a summary. The runner is kept isolated from the scenario specifics
// so scenarios just build the spec list and hand it off.

const fs = require('fs');
const path = require('path');
const child_process = require('child_process');
const { MetricsBuffer, formatSummaryLine } = require('./metrics');

const RESULTS_DIR = path.resolve(__dirname, '..', 'results');

const ensureResultsDir = () => {
  if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
  }
};

const csvPath = (scenario, protocol, ts = Date.now()) => {
  ensureResultsDir();
  return path.join(RESULTS_DIR, `${scenario}-${protocol}-${ts}.csv`);
};

const writeCsv = (filePath, buffer) => {
  fs.writeFileSync(filePath, buffer.toCsv());
  return filePath;
};

// Fork one child per spec. Returns a Promise<void> that resolves once every
// child has exited. Metric messages are appended to `buffer`.
const forkAll = (specs, baseUrl, buffer, { childPath, forkOptions } = {}) => {
  return new Promise((resolve, reject) => {
    if (!specs.length) {
      return resolve();
    }
    const modulePath = childPath || path.resolve(__dirname, 'client.js');
    let outstanding = specs.length;
    const onExit = () => {
      outstanding -= 1;
      if (outstanding === 0) {
        resolve();
      }
    };
    for (const spec of specs) {
      const child = child_process.fork(modulePath, [JSON.stringify(spec)], Object.assign(
        {
          env: Object.assign({}, process.env, {
            PERF_SYNC_BASE_URL: baseUrl,
            PERF_SYNC_SPEC: JSON.stringify(spec),
          }),
          silent: false,
        },
        forkOptions || {},
      ));
      child.on('message', (msg) => {
        if (msg && msg.type === 'metric' && msg.row) {
          buffer.add(msg.row);
        }
      });
      child.on('exit', onExit);
      child.on('error', reject);
    }
  });
};

const summarize = (buffer, scenario) => {
  const lines = [];
  const groups = buffer.groupBy((r) => r.protocol);
  for (const [protocol, rows] of groups) {
    const inner = new MetricsBuffer();
    inner.rows = rows;
    const summary = inner.summarize();
    lines.push(`scenario=${scenario} protocol=${protocol} users=${rows.length}`);
    lines.push('  ' + formatSummaryLine(summary));
  }
  return lines.join('\n');
};

module.exports = {
  RESULTS_DIR,
  csvPath,
  ensureResultsDir,
  forkAll,
  summarize,
  writeCsv,
};
