'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { expect } = require('chai');

const runner = require('../lib/runner');
const { MetricsBuffer } = require('../lib/metrics');

describe('runner', () => {
  describe('csvPath / writeCsv', () => {
    it('returns a path under the results dir tagged with scenario, protocol, and ts', () => {
      const p = runner.csvPath('baseline', 'pg-sync', 9999);
      expect(p).to.match(/perf-sync\/results\/baseline-pg-sync-9999\.csv$/);
    });

    it('writeCsv writes the buffer\'s CSV to disk', () => {
      const tmp = path.join(os.tmpdir(), `perf-sync-test-${Date.now()}.csv`);
      const buf = new MetricsBuffer();
      buf.add({ scenario: 'baseline', protocol: 'pg-sync', user_id: 'x', sync_index: 0, elapsed_ms: 10 });
      runner.writeCsv(tmp, buf);
      const contents = fs.readFileSync(tmp, 'utf8');
      try {
        expect(contents.split('\n')[0]).to.contain('scenario');
        expect(contents).to.contain('baseline,pg-sync,x,0');
      } finally {
        fs.unlinkSync(tmp);
      }
    });
  });

  describe('summarize', () => {
    it('emits one block per protocol', () => {
      const buf = new MetricsBuffer();
      for (let i = 0; i < 3; i++) {
        buf.add({ scenario: 'baseline', protocol: 'pg-sync', user_id: `u${i}`, elapsed_ms: 10 + i });
      }
      for (let i = 0; i < 2; i++) {
        buf.add({ scenario: 'baseline', protocol: 'nairobi', user_id: `n${i}`, elapsed_ms: 100 + i });
      }
      const text = runner.summarize(buf, 'baseline');
      expect(text).to.contain('scenario=baseline protocol=pg-sync users=3');
      expect(text).to.contain('scenario=baseline protocol=nairobi users=2');
      expect(text).to.contain('p50=');
    });
  });

  describe('forkAll', () => {
    it('resolves immediately with an empty spec list', async () => {
      await runner.forkAll([], 'http://server', new MetricsBuffer());
    });

    it('collects metric IPC messages from child processes into the buffer', async function () {
      this.timeout(10000);
      const fakeChild = path.join(os.tmpdir(), `perf-sync-fake-child-${Date.now()}.js`);
      fs.writeFileSync(fakeChild, `
        process.send({ type: 'metric', row: { scenario: 'baseline', protocol: 'pg-sync', user_id: 'fake', sync_index: 0, kind: 'initial', docs_pulled: 1, docs_pushed: 0, elapsed_ms: 5, error: '' } });
        process.send({ type: 'done', user_id: 'fake' });
        setTimeout(() => process.exit(0), 30);
      `);
      try {
        const buf = new MetricsBuffer();
        await runner.forkAll([{ id: 'fake' }], 'http://server', buf, { childPath: fakeChild });
        expect(buf.rows).to.have.length(1);
        expect(buf.rows[0]).to.include({ user_id: 'fake', protocol: 'pg-sync' });
      } finally {
        fs.unlinkSync(fakeChild);
      }
    });
  });
});
