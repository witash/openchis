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
  'compare-protocols': require('./scenarios/compare-protocols'),
};

const PG_SYNC_ALIASES = new Set(['pg-sync', 'pg', 'postgres']);
const NAIROBI_ALIASES = new Set(['nairobi', 'couch', 'couchdb']);
const PROTOCOLS = new Set([...PG_SYNC_ALIASES, ...NAIROBI_ALIASES]);
const canonicalProtocol = (raw) => {
  if (PG_SYNC_ALIASES.has(raw)) {
    return 'pg-sync';
  }
  if (NAIROBI_ALIASES.has(raw)) {
    return 'nairobi';
  }
  return null;
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
    '  --users=<n>             concurrent virtual users (default 1)',
    '  --protocol=pg-sync      protocol to test (pg-sync or nairobi; ignored by compare-protocols)',
    '  --pending-uploads=<n>   pending docs to seed in each user\'s local Pouch before sync (default 0)',
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
  const protocol = canonicalProtocol(protoArg);
  if (!protocol) {
    throw new Error(`unknown protocol: ${protoArg} (supported: pg-sync, nairobi)`);
  }
  const runId = String(parsed.flags['run-id'] || Date.now());
  const pendingRaw = parsed.flags['pending-uploads'];
  const pendingUploads = pendingRaw === undefined || pendingRaw === true ? 0 : parseInt(pendingRaw, 10);
  if (!Number.isFinite(pendingUploads) || pendingUploads < 0) {
    throw new Error(`--pending-uploads must be a non-negative integer (got ${pendingRaw})`);
  }
  return {
    baseUrl: config.url,
    admin: config.admin,
    userCount,
    protocol,
    runId,
    pendingUploads,
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
  PG_SYNC_ALIASES,
  NAIROBI_ALIASES,
  SCENARIOS,
  buildContext,
  canonicalProtocol,
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
