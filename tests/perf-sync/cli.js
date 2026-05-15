#!/usr/bin/env node
'use strict';

// Perf-sync CLI.
//
//   node tests/perf-sync/cli.js --help
//   node tests/perf-sync/cli.js baseline --users=50 --protocol=both
//   node tests/perf-sync/cli.js initial-vs-ongoing --users=50 --warmed-fraction=0.8 --protocol=both

const fs = require('fs');
const path = require('path');

const SCENARIOS = {
  baseline: require('./scenarios/baseline'),
  'initial-vs-ongoing': require('./scenarios/initial-vs-ongoing'),
};

const PROTOCOLS = {
  nairobi: ['nairobi'],
  pg: ['pg-sync'],
  postgres: ['pg-sync'],
  'pg-sync': ['pg-sync'],
  both: ['nairobi', 'pg-sync'],
};

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
    '  --users=<n>             number of concurrent virtual users (default 10)',
    '  --protocol=<nairobi|pg-sync|both> protocol(s) to test (default both)',
    '  --warmed-fraction=<f>   fraction of users warmed up (initial-vs-ongoing only, default 0.8)',
    '  --run-id=<id>           label baked into the CHW username + doc shape; defaults to a timestamp',
    '  --config=<path>         load defaults from this JSON file (default tests/perf-sync/config.json)',
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
  const userCount = parseInt(parsed.flags.users || '10', 10);
  const warmedFraction = parseFloat(parsed.flags['warmed-fraction'] || '0.8');
  const protoArg = parsed.flags.protocol || 'both';
  const protocols = PROTOCOLS[protoArg];
  if (!protocols) {
    throw new Error(`unknown protocol: ${protoArg}`);
  }
  const runId = String(parsed.flags['run-id'] || Date.now());
  return {
    baseUrl: config.url,
    admin: config.admin,
    userCount,
    warmedFraction,
    protocols,
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
