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
}

// Linear-interpolation percentile. Returns 0 for an empty input.
// Matches numpy's `numpy.percentile(..., interpolation='linear')` for the
// in-range case we care about.
const percentile = (values, p) => {
  if (!values || !values.length) {
    return 0;
  }
  const sorted = values.slice().sort((a, b) => a - b);
  if (sorted.length === 1) {
    return sorted[0];
  }
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) {
    return sorted[lo];
  }
  return sorted[lo] * (hi - idx) + sorted[hi] * (idx - lo);
};

// Summarize an elapsed_ms array as min / p50 / p95 / max / total.
// Rounds to the nearest ms — sub-millisecond precision is noise in this
// harness's measurement budget.
const summarizeElapsed = (values) => {
  const arr = (values || []).map((v) => Number(v) || 0);
  const round = (n) => Math.round(n);
  return {
    n: arr.length,
    min_ms: round(arr.length ? Math.min(...arr) : 0),
    p50_ms: round(percentile(arr, 50)),
    p95_ms: round(percentile(arr, 95)),
    max_ms: round(arr.length ? Math.max(...arr) : 0),
    total_ms: round(arr.reduce((a, v) => a + v, 0)),
  };
};

module.exports = {
  CSV_HEADER,
  MetricsBuffer,
  escapeCsvField,
  percentile,
  rowToCsv,
  summarizeElapsed,
  toCsv,
};
