'use strict';

const CSV_HEADER = [
  'scenario',
  'protocol',
  'user_id',
  'sync_index',
  'kind',
  'docs_pulled',
  'docs_pushed',
  'elapsed_ms',
  'error',
];

const escapeCsvField = (value) => {
  if (value === null || value === undefined) {
    return '';
  }
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
};

const rowToCsv = (row) => CSV_HEADER.map((col) => escapeCsvField(row[col])).join(',');

const toCsv = (rows) => {
  const lines = [CSV_HEADER.join(',')];
  for (const row of rows) {
    lines.push(rowToCsv(row));
  }
  return lines.join('\n') + '\n';
};

// Nearest-rank percentile on a sorted copy of `values`. Stable for small
// samples and matches what people expect from p50/p95/p99 stats.
const percentile = (values, p) => {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 100) {
    throw new Error(`percentile: invalid p=${p}`);
  }
  const sorted = values.slice().sort((a, b) => a - b);
  if (p === 0) {
    return sorted[0];
  }
  if (p === 100) {
    return sorted[sorted.length - 1];
  }
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1];
};

const summarize = (rows) => {
  const successes = rows.filter((r) => !r.error);
  const errors = rows.length - successes.length;
  const elapsed = successes.map((r) => Number(r.elapsed_ms)).filter((n) => Number.isFinite(n));
  const totalElapsedSec = elapsed.reduce((a, b) => a + b, 0) / 1000;
  const throughput = totalElapsedSec > 0 ? elapsed.length / totalElapsedSec : 0;
  return {
    count: rows.length,
    errors,
    p50: percentile(elapsed, 50),
    p95: percentile(elapsed, 95),
    p99: percentile(elapsed, 99),
    throughput,
  };
};

const formatSummaryLine = (summary) => {
  const fmt = (v) => (v === null || v === undefined ? 'n/a' : `${Math.round(v)}ms`);
  const tp = summary.throughput ? `${summary.throughput.toFixed(1)}/s` : '0/s';
  return `p50=${fmt(summary.p50)}  p95=${fmt(summary.p95)}  p99=${fmt(summary.p99)}  throughput=${tp}  errors=${summary.errors}`;
};

class MetricsBuffer {
  constructor() {
    this.rows = [];
  }
  add(row) {
    const normalized = {};
    for (const col of CSV_HEADER) {
      normalized[col] = row[col] === undefined ? '' : row[col];
    }
    this.rows.push(normalized);
    return normalized;
  }
  toCsv() {
    return toCsv(this.rows);
  }
  groupBy(keyFn) {
    const out = new Map();
    for (const row of this.rows) {
      const k = keyFn(row);
      if (!out.has(k)) {
        out.set(k, []);
      }
      out.get(k).push(row);
    }
    return out;
  }
  summarize() {
    return summarize(this.rows);
  }
}

module.exports = {
  CSV_HEADER,
  MetricsBuffer,
  escapeCsvField,
  formatSummaryLine,
  percentile,
  rowToCsv,
  summarize,
  toCsv,
};
