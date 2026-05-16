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

module.exports = {
  CSV_HEADER,
  MetricsBuffer,
  escapeCsvField,
  rowToCsv,
  toCsv,
};
