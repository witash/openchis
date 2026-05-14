'use strict';

const { expect } = require('chai');
const metrics = require('../lib/metrics');

describe('metrics', () => {
  describe('percentile', () => {
    it('returns null for an empty array', () => {
      expect(metrics.percentile([], 50)).to.equal(null);
    });

    it('returns the single value for a one-element array', () => {
      expect(metrics.percentile([42], 50)).to.equal(42);
      expect(metrics.percentile([42], 99)).to.equal(42);
    });

    it('returns the median for an odd-sized array', () => {
      expect(metrics.percentile([3, 1, 2], 50)).to.equal(2);
    });

    it('returns p50/p95/p99 over 1..100 using nearest-rank', () => {
      const values = Array.from({ length: 100 }, (_, i) => i + 1);
      expect(metrics.percentile(values, 50)).to.equal(50);
      expect(metrics.percentile(values, 95)).to.equal(95);
      expect(metrics.percentile(values, 99)).to.equal(99);
    });

    it('returns the max for p100 and the min for p0', () => {
      const values = [10, 20, 30, 40];
      expect(metrics.percentile(values, 100)).to.equal(40);
      expect(metrics.percentile(values, 0)).to.equal(10);
    });

    it('does not mutate the input array', () => {
      const values = [4, 1, 3, 2];
      const copy = values.slice();
      metrics.percentile(values, 50);
      expect(values).to.deep.equal(copy);
    });

    it('throws on an out-of-range percentile', () => {
      expect(() => metrics.percentile([1, 2], -1)).to.throw(/invalid p/);
      expect(() => metrics.percentile([1, 2], 101)).to.throw(/invalid p/);
    });
  });

  describe('escapeCsvField', () => {
    it('returns the value unchanged when no special characters', () => {
      expect(metrics.escapeCsvField('hello')).to.equal('hello');
      expect(metrics.escapeCsvField(42)).to.equal('42');
    });

    it('returns an empty string for null/undefined', () => {
      expect(metrics.escapeCsvField(null)).to.equal('');
      expect(metrics.escapeCsvField(undefined)).to.equal('');
    });

    it('quotes and escapes embedded quotes', () => {
      expect(metrics.escapeCsvField('a"b')).to.equal('"a""b"');
    });

    it('quotes values containing commas or newlines', () => {
      expect(metrics.escapeCsvField('a,b')).to.equal('"a,b"');
      expect(metrics.escapeCsvField('a\nb')).to.equal('"a\nb"');
    });
  });

  describe('toCsv', () => {
    it('emits a header row even when the buffer is empty', () => {
      const csv = metrics.toCsv([]);
      expect(csv.split('\n')[0]).to.equal(metrics.CSV_HEADER.join(','));
    });

    it('emits one line per row with quoted error messages', () => {
      const rows = [
        {
          scenario: 'baseline',
          protocol: 'nairobi',
          user_id: 'u1',
          sync_index: 0,
          kind: 'initial',
          docs_pulled: 500,
          docs_pushed: 0,
          elapsed_ms: 820,
          error: '',
        },
        {
          scenario: 'baseline',
          protocol: 'pg-sync',
          user_id: 'u2',
          sync_index: 0,
          kind: 'initial',
          docs_pulled: 0,
          docs_pushed: 0,
          elapsed_ms: 0,
          error: 'fetch failed, "boom"',
        },
      ];
      const csv = metrics.toCsv(rows);
      const lines = csv.trim().split('\n');
      expect(lines).to.have.length(3);
      expect(lines[1]).to.equal('baseline,nairobi,u1,0,initial,500,0,820,');
      expect(lines[2]).to.equal('baseline,pg-sync,u2,0,initial,0,0,0,"fetch failed, ""boom"""');
    });
  });

  describe('MetricsBuffer', () => {
    it('add() fills missing CSV columns with empty strings', () => {
      const buf = new metrics.MetricsBuffer();
      const stored = buf.add({ scenario: 'baseline', protocol: 'pg-sync' });
      for (const col of metrics.CSV_HEADER) {
        expect(stored).to.have.property(col);
      }
      expect(stored.user_id).to.equal('');
    });

    it('toCsv() round-trips through the toCsv() helper', () => {
      const buf = new metrics.MetricsBuffer();
      buf.add({ scenario: 's', protocol: 'p', user_id: 'u', elapsed_ms: 1 });
      const csv = buf.toCsv();
      expect(csv.split('\n')[0]).to.equal(metrics.CSV_HEADER.join(','));
      expect(csv).to.contain('s,p,u');
    });

    it('summarize() reports percentiles and error counts', () => {
      const buf = new metrics.MetricsBuffer();
      for (let i = 1; i <= 100; i++) {
        buf.add({ user_id: `u${i}`, elapsed_ms: i, error: '' });
      }
      buf.add({ user_id: 'uX', elapsed_ms: 0, error: 'boom' });
      const summary = buf.summarize();
      expect(summary.count).to.equal(101);
      expect(summary.errors).to.equal(1);
      expect(summary.p50).to.equal(50);
      expect(summary.p95).to.equal(95);
      expect(summary.p99).to.equal(99);
      expect(summary.throughput).to.be.greaterThan(0);
    });

    it('groupBy() partitions rows by the chosen key', () => {
      const buf = new metrics.MetricsBuffer();
      buf.add({ user_id: 'a', protocol: 'nairobi', elapsed_ms: 1 });
      buf.add({ user_id: 'b', protocol: 'pg-sync', elapsed_ms: 2 });
      buf.add({ user_id: 'c', protocol: 'nairobi', elapsed_ms: 3 });
      const groups = buf.groupBy((r) => r.protocol);
      expect(groups.get('nairobi')).to.have.length(2);
      expect(groups.get('pg-sync')).to.have.length(1);
    });
  });

  describe('formatSummaryLine', () => {
    it('formats the standard p50/p95/p99/throughput line', () => {
      const line = metrics.formatSummaryLine({
        p50: 100, p95: 200, p99: 300, throughput: 12.3, errors: 4,
      });
      expect(line).to.equal('p50=100ms  p95=200ms  p99=300ms  throughput=12.3/s  errors=4');
    });

    it('substitutes n/a for missing percentiles', () => {
      const line = metrics.formatSummaryLine({
        p50: null, p95: null, p99: null, throughput: 0, errors: 0,
      });
      expect(line).to.contain('p50=n/a');
      expect(line).to.contain('throughput=0/s');
    });
  });
});
