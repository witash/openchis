#!/usr/bin/env node
'use strict';

// Perf-sync CLI — Phase A (single-user pg-sync baseline against a live stack).
//
//   node tests/perf-sync/cli.js baseline --users=1 --protocol=pg-sync --run-id=smoke

const fs = require('fs');
const path = require('path');

const SCENARIOS = {
  baseline: require('./scenarios/baseline'),
  'initial-vs-ongoing': require('./scenarios/initial-vs-ongoing'),
};

const PROTOCOLS = new Set(['pg-sync', 'pg', 'postgres']);

const parseArgs = (argv) => {
  const out = { _: [], flags: {} };
  for (const tok of argv) {
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      if (eq >= 0) {
        out.flags[tok.slice(2, eq)] = tok.slice(eq + 1);
      } else {
        out.flags[tok.slice(2)] = true;
      }
    } else {
      out._.push(tok);
    }
  }
  return out;
};

const printHelp = () => {
  process.stdout.write([
    'Usage: node tests/perf-sync/cli.js <scenario> [options]',
    '',
    'Scenarios:',
    ...Object.keys(SCENARIOS).map((s) => `  ${s}`),
    '',
    'Options:',
    '  --users=<n>             concurrent virtual users (default 1; Phase A is 1)',
    '  --protocol=pg-sync      protocol to test (only pg-sync in Phase A)',
    '  --run-id=<id>           label baked into the CHW username (default a timestamp)',
    '  --config=<path>         JSON config (default tests/perf-sync/config.json)',
    '',
  ].join('\n'));
};

const loadConfig = (configPath) => {
  const defaultPath = path.resolve(__dirname, 'config.json');
  const target = configPath ? path.resolve(configPath) : defaultPath;
  if (!fs.existsSync(target)) {
    throw new Error(`config file not found: ${target}`);
  }
  return JSON.parse(fs.readFileSync(target, 'utf8'));
};

const buildContext = (parsed) => {
  const config = loadConfig(parsed.flags.config);
  if (!config.url) {
    throw new Error('config: missing `url`');
  }
  if (!config.admin || !config.admin.username) {
    throw new Error('config: missing `admin.username` / `admin.password`');
  }
  const userCount = parseInt(parsed.flags.users || '1', 10);
  const protoArg = parsed.flags.protocol || 'pg-sync';
  if (!PROTOCOLS.has(protoArg)) {
    throw new Error(`unknown protocol: ${protoArg} (only pg-sync supported in Phase A)`);
  }
  const runId = String(parsed.flags['run-id'] || Date.now());
  return {
    baseUrl: config.url,
    admin: config.admin,
    userCount,
    protocol: 'pg-sync',
    runId,
  };
};

const main = async (argv) => {
  const parsed = parseArgs(argv.slice(2));
  if (!parsed._.length || parsed.flags.help) {
    printHelp();
    return 0;
  }
  const scenarioName = parsed._[0];
  const scenario = SCENARIOS[scenarioName];
  if (!scenario) {
    process.stderr.write(`unknown scenario: ${scenarioName}\n\n`);
    printHelp();
    return 2;
  }
  const ctx = buildContext(parsed);
  await scenario.run(ctx);
  return 0;
};

module.exports = {
  PROTOCOLS,
  SCENARIOS,
  buildContext,
  main,
  parseArgs,
};

if (require.main === module) {
  /* istanbul ignore next */
  main(process.argv).then(
    (code) => process.exit(code || 0),
    (err) => {
      process.stderr.write(`perf-sync: ${err && err.stack || err}\n`);
      process.exit(1);
    },
  );
}
