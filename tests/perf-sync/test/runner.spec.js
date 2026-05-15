'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { expect } = require('chai');
const sinon = require('sinon');

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

  describe('runAll', () => {
    it('resolves immediately with an empty spec list', async () => {
      await runner.runAll([], 'http://server', new MetricsBuffer());
    });

    it('invokes runClient once per spec in parallel and routes metric messages into the buffer', async () => {
      const runClient = sinon.stub().callsFake(async ({ spec, sendMessage }) => {
        sendMessage({ type: 'metric', row: { user_id: spec.id, scenario: 'baseline', protocol: 'pg-sync', elapsed_ms: 1 } });
        sendMessage({ type: 'done', user_id: spec.id });
      });
      const buffer = new MetricsBuffer();
      await runner.runAll(
        [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        'http://server',
        buffer,
        {
          runClient,
          PouchDB: function FakePouch() {},
          fetchFn: () => Promise.reject(new Error('unused')),
          replicateFn: () => Promise.reject(new Error('unused')),
        },
      );
      expect(runClient.callCount).to.equal(3);
      expect(buffer.rows.map((r) => r.user_id).sort()).to.deep.equal(['a', 'b', 'c']);
    });

    it('runs the per-user work concurrently, not serially', async () => {
      // Each fake runClient blocks for 30ms; three of them in serial would
      // take ~90ms but Promise.all parallelism should finish near 30ms.
      const delay = (ms) => new Promise((r) => setTimeout(r, ms));
      const runClient = sinon.stub().callsFake(async ({ spec, sendMessage }) => {
        await delay(30);
        sendMessage({ type: 'metric', row: { user_id: spec.id } });
      });
      const start = Date.now();
      await runner.runAll(
        [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        'http://server',
        new MetricsBuffer(),
        { runClient, PouchDB: function FakePouch() {}, fetchFn: () => null, replicateFn: () => null },
      );
      expect(Date.now() - start).to.be.lessThan(75);
    });

  });
});
