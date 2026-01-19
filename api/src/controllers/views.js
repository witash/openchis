const db = require('../db');
const serverUtils = require('../server-utils');
const logger = require('@medic/logger');
const sqlViews = require('./sql_views');

// Parse key from query params (handles JSON strings)
const parseKey = (key) => {
  if (key === undefined || key === null) {
    return undefined;
  }
  if (typeof key === 'string') {
    try {
      return JSON.parse(key);
    } catch {
      return key;
    }
  }
  return key;
};

// Parse standard query parameters
const parseQuery = (query) => ({
  key: parseKey(query.key),
  keys: parseKey(query.keys),
  startkey: parseKey(query.startkey || query.start_key),
  endkey: parseKey(query.endkey || query.end_key),
  limit: query.limit ? parseInt(query.limit) : null,
  skip: query.skip ? parseInt(query.skip) : 0,
  descending: query.descending === true || query.descending === 'true',
  include_docs: query.include_docs === true || query.include_docs === 'true',
  reduce: query.reduce !== false && query.reduce !== 'false',
  group: query.group === true || query.group === 'true'
});

// Query builder helper
class QueryBuilder {
  constructor(baseTable) {
    this.select = [];
    this.from = baseTable;
    this.joins = [];
    this.where = [];
    this.orderBy = [];
    this.params = [];
    this.paramIdx = 1;
  }

  addSelect(columns) {
    this.select.push(...(Array.isArray(columns) ? columns : [columns]));
    return this;
  }

  addJoin(join) {
    this.joins.push(join);
    return this;
  }

  addWhere(condition, ...values) {
    const placeholders = values.map(() => `$${this.paramIdx++}`);
    let condWithPlaceholders = condition;
    placeholders.forEach((ph, i) => {
      condWithPlaceholders = condWithPlaceholders.replace('?', ph);
    });
    this.where.push(condWithPlaceholders);
    this.params.push(...values);
    return this;
  }

  addWhereRaw(condition) {
    this.where.push(condition);
    return this;
  }

  addOrder(column, descending = false) {
    this.orderBy.push(`${column} ${descending ? 'DESC' : 'ASC'}`);
    return this;
  }

  addOrderRaw(order) {
    this.orderBy.push(order);
    return this;
  }

  addPagination(limit, skip) {
    if (limit) {
      this.limit = limit;
      this.limitParam = this.paramIdx++;
      this.params.push(limit);
    }
    if (skip) {
      this.skip = skip;
      this.skipParam = this.paramIdx++;
      this.params.push(skip);
    }
    return this;
  }

  // Add key/range filters for a single column
  addKeyFilter(column, key, startkey, endkey, descending, extractValue = v => v) {
    if (key !== undefined) {
      this.addWhere(`${column} = ?`, extractValue(key));
    } else if (startkey !== undefined || endkey !== undefined) {
      if (startkey !== undefined) {
        const op = descending ? '<=' : '>=';
        this.addWhere(`${column} ${op} ?`, extractValue(startkey));
      }
      if (endkey !== undefined) {
        const op = descending ? '>=' : '<=';
        this.addWhere(`${column} ${op} ?`, extractValue(endkey));
      }
    }
    return this;
  }

  // Add filter for keys array
  addKeysFilter(column, keys, extractValue = v => v) {
    if (keys && Array.isArray(keys)) {
      const values = keys.map(extractValue);
      this.addWhere(`${column} = ANY(?)`, values);
    }
    return this;
  }

  build() {
    let sql = `SELECT ${this.select.join(', ')} FROM ${this.from}`;
    if (this.joins.length) {
      sql += ' ' + this.joins.join(' ');
    }
    if (this.where.length) {
      sql += ` WHERE ${this.where.join(' AND ')}`;
    }
    if (this.orderBy.length) {
      sql += ` ORDER BY ${this.orderBy.join(', ')}`;
    }
    if (this.limit) {
      sql += ` LIMIT $${this.limitParam}`;
    }
    if (this.skip) {
      sql += ` OFFSET $${this.skipParam}`;
    }
    return { sql, params: this.params };
  }

  async execute() {
    const { sql, params } = this.build();
    return postgres.pool.query(sql, params);
  }
}

// Add include_docs to rows by fetching from medic_documents
const addIncludeDocs = async (rows) => {
  if (!rows.length) {
    return rows;
  }
  const ids = [...new Set(rows.map(r => r.id))];
  const result = await postgres.pool.query(
    `SELECT DISTINCT ON (_id) _id, doc FROM medic_documents WHERE _id = ANY($1) ORDER BY _id, seq DESC`,
    [ids]
  );
  const docsById = Object.fromEntries(result.rows.map(r => [r._id, r.doc]));
  return rows.map(row => ({ ...row, doc: docsById[row.id] || null }));
};

// Format CouchDB-style response
const formatResponse = async (rows, query, totalRows = null) => {
  const resultRows = query.include_docs ? await addIncludeDocs(rows) : rows;
  return {
    total_rows: totalRows !== null ? totalRows : resultRows.length,
    offset: query.skip || 0,
    rows: resultRows
  };
};

// Helper to extract value from array key at index, or return scalar
const keyAt = (idx) => (key) => Array.isArray(key) ? key[idx] : key;
const keyFirst = keyAt(0);

// View implementations

const contacts_by_parent = async (userCtx, rawQuery) => {
  const q = parseQuery(rawQuery);
  const qb = new QueryBuilder('contacts')
    .addSelect(['id', 'parent', 'contact_type'])
    .addWhereRaw('parent IS NOT NULL');

  if (q.key) {
    qb.addWhere('parent = ?', q.key[0]);
    if (q.key[1] !== undefined) {
      qb.addWhere('contact_type = ?', q.key[1]);
    }
  } else if (q.startkey || q.endkey) {
    if (q.startkey) {
      const op = q.descending ? '<=' : '>=';
      qb.addWhere(`(parent, COALESCE(contact_type, '')) ${op} (?, ?)`, q.startkey[0], q.startkey[1] || '');
    }
    if (q.endkey) {
      const op = q.descending ? '>=' : '<=';
      qb.addWhere(`(parent, COALESCE(contact_type, '')) ${op} (?, ?)`, q.endkey[0], q.endkey[1] || '');
    }
  }

  qb.addOrder('parent', q.descending).addOrder('contact_type', q.descending).addPagination(q.limit, q.skip);

  const result = await qb.execute();
  const rows = result.rows.map(r => ({ id: r.id, key: [r.parent, r.contact_type], value: null }));
  return formatResponse(rows, q);
};

const contacts_by_phone = async (userCtx, rawQuery) => {
  const q = parseQuery(rawQuery);
  const qb = new QueryBuilder('contacts')
    .addSelect(['id', 'phone'])
    .addWhereRaw('phone IS NOT NULL')
    .addKeyFilter('phone', q.key, q.startkey, q.endkey, q.descending)
    .addKeysFilter('phone', q.keys)
    .addOrder('phone', q.descending)
    .addPagination(q.limit, q.skip);

  const result = await qb.execute();
  const rows = result.rows.map(r => ({ id: r.id, key: r.phone, value: null }));
  return formatResponse(rows, q);
};

const contacts_by_reference = async (userCtx, rawQuery) => {
  const q = parseQuery(rawQuery);
  const prefix = q.key?.[0] || q.startkey?.[0];
  const value = q.key?.[1] || q.startkey?.[1];

  if (!prefix) {
    return formatResponse([], q);
  }

  let result;
  if (prefix === 'shortcode') {
    const qb = new QueryBuilder('contacts')
      .addSelect(['id', 'shortcode'])
      .addWhereRaw('shortcode IS NOT NULL');
    if (value) {
      qb.addWhere('shortcode = ?', value);
    }
    qb.addOrder('shortcode').addPagination(q.limit, q.skip);
    result = await qb.execute();
    const rows = result.rows.map(r => ({ id: r.id, key: ['shortcode', r.shortcode], value: null }));
    return formatResponse(rows, q);
  } else if (prefix === 'external') {
    const qb = new QueryBuilder('medic_documents d')
      .addSelect(["DISTINCT ON (d._id) d._id as id", "UPPER(d.doc->>'rc_code') as rc_code"])
      .addWhereRaw("d.doc->>'rc_code' IS NOT NULL")
      .addWhereRaw("d.type IN ('contact', 'clinic', 'health_center', 'district_hospital', 'national_office', 'person')");
    if (value) {
      qb.addWhere("UPPER(d.doc->>'rc_code') = ?", value.toUpperCase());
    }
    qb.addOrderRaw('d._id, d.seq DESC').addPagination(q.limit, q.skip);
    result = await qb.execute();
    const rows = result.rows.map(r => ({ id: r.id, key: ['external', r.rc_code], value: null }));
    return formatResponse(rows, q);
  }

  return formatResponse([], q);
};

const contacts_by_type = async (userCtx, rawQuery) => {
  const q = parseQuery(rawQuery);

  const sql = `
    SELECT c.id, c.contact_type, d.doc->>'date_of_death' as date_of_death, c.muted, c.name,
           CASE c.contact_type
             WHEN 'district_hospital' THEN 0 WHEN 'health_center' THEN 1
             WHEN 'clinic' THEN 2 WHEN 'person' THEN 3 ELSE 4
           END as type_idx
    FROM contacts c
    LEFT JOIN LATERAL (SELECT doc FROM medic_documents WHERE _id = c.id ORDER BY seq DESC LIMIT 1) d ON true
    WHERE c.contact_type IS NOT NULL
    ${q.key ? 'AND c.contact_type = $1' : ''}
    ${q.keys ? 'AND c.contact_type = ANY($1)' : ''}
    ORDER BY c.contact_type ${q.descending ? 'DESC' : 'ASC'},
             (COALESCE(d.doc->>'date_of_death', '') <> '') ${q.descending ? 'DESC' : 'ASC'},
             (c.muted IS NOT NULL) ${q.descending ? 'DESC' : 'ASC'},
             type_idx ${q.descending ? 'DESC' : 'ASC'},
             LOWER(COALESCE(c.name, '')) ${q.descending ? 'DESC' : 'ASC'}
    ${q.limit ? `LIMIT ${q.limit}` : ''} ${q.skip ? `OFFSET ${q.skip}` : ''}`;

  const params = q.key ? [keyFirst(q.key)] : q.keys ? [q.keys.map(keyFirst)] : [];
  const result = await postgres.pool.query(sql, params);

  const rows = result.rows.map(r => {
    const order = `${!!r.date_of_death} ${!!r.muted} ${r.type_idx} ${(r.name || '').toLowerCase()}`;
    return { id: r.id, key: [r.contact_type], value: order };
  });
  return formatResponse(rows, q);
};

const data_records_by_type = async (userCtx, rawQuery) => {
  const q = parseQuery(rawQuery);

  if (q.reduce) {
    let sql = `SELECT CASE WHEN form IS NOT NULL THEN 'report' ELSE 'message' END as record_type, COUNT(*) as count FROM reports`;
    if (q.key === 'report') sql += ` WHERE form IS NOT NULL`;
    else if (q.key === 'message') sql += ` WHERE form IS NULL`;
    if (q.group) sql += ` GROUP BY record_type`;

    const result = await postgres.pool.query(sql);
    if (q.group) {
      return { rows: result.rows.map(r => ({ key: r.record_type, value: parseInt(r.count) })) };
    }
    return { rows: [{ key: null, value: result.rows.reduce((sum, r) => sum + parseInt(r.count), 0) }] };
  }

  const qb = new QueryBuilder('reports').addSelect(['id', 'form']);
  if (q.key === 'report') qb.addWhereRaw('form IS NOT NULL');
  else if (q.key === 'message') qb.addWhereRaw('form IS NULL');
  qb.addOrder('id').addPagination(q.limit, q.skip);

  const result = await qb.execute();
  const rows = result.rows.map(r => ({ id: r.id, key: r.form ? 'report' : 'message', value: null }));
  return formatResponse(rows, q);
};

const doc_by_type = async (userCtx, rawQuery) => {
  const q = parseQuery(rawQuery);
  const qb = new QueryBuilder('(SELECT DISTINCT ON (_id) _id as id, type FROM medic_documents ORDER BY _id, seq DESC) sub')
    .addSelect(['id', 'type'])
    .addKeyFilter('type', q.key, q.startkey, q.endkey, q.descending, keyFirst)
    .addKeysFilter('type', q.keys, keyFirst)
    .addOrder('type', q.descending)
    .addPagination(q.limit, q.skip);

  const result = await qb.execute();
  const rows = result.rows.map(r => ({ id: r.id, key: [r.type], value: null }));
  return formatResponse(rows, q);
};

const reports_by_date = async (userCtx, rawQuery) => {
  const q = parseQuery(rawQuery);
  const qb = new QueryBuilder('reports')
    .addSelect(['id', 'reported_date'])
    .addWhereRaw('form IS NOT NULL')
    .addKeyFilter('reported_date', q.key, q.startkey, q.endkey, q.descending, keyFirst)
    .addOrder('reported_date', q.descending)
    .addPagination(q.limit, q.skip);

  const result = await qb.execute();
  const rows = result.rows.map(r => ({ id: r.id, key: [r.reported_date], value: r.reported_date }));
  return formatResponse(rows, q);
};

const reports_by_form = async (userCtx, rawQuery) => {
  const q = parseQuery(rawQuery);
  const qb = new QueryBuilder('reports')
    .addSelect(['id', 'form', 'reported_date'])
    .addWhereRaw('form IS NOT NULL')
    .addKeyFilter('form', q.key, q.startkey, q.endkey, q.descending, keyFirst)
    .addKeysFilter('form', q.keys, keyFirst)
    .addOrder('form', q.descending)
    .addPagination(q.limit, q.skip);

  const result = await qb.execute();
  const rows = result.rows.map(r => ({ id: r.id, key: [r.form], value: r.reported_date }));
  return formatResponse(rows, q);
};

const reports_by_subject = async (userCtx, rawQuery) => {
  const q = parseQuery(rawQuery);
  const qb = new QueryBuilder('reports')
    .addSelect(['id', 'subject', 'reported_date'])
    .addWhereRaw('form IS NOT NULL')
    .addWhereRaw('subject IS NOT NULL')
    .addKeyFilter('subject', q.key, q.startkey, q.endkey, q.descending)
    .addKeysFilter('subject', q.keys)
    .addOrder('subject', q.descending)
    .addPagination(q.limit, q.skip);

  const result = await qb.execute();
  const rows = result.rows.map(r => ({ id: r.id, key: r.subject, value: r.reported_date }));
  return formatResponse(rows, q);
};

const reports_by_validity = async (userCtx, rawQuery) => {
  const q = parseQuery(rawQuery);
  const qb = new QueryBuilder('reports')
    .addSelect(['id', 'has_errors', 'reported_date'])
    .addWhereRaw('form IS NOT NULL');

  // key=true means valid (no errors), key=false means invalid (has errors)
  const keyVal = q.key !== undefined ? keyFirst(q.key) : undefined;
  if (keyVal === true || keyVal === 'true') {
    qb.addWhereRaw('(has_errors = false OR has_errors IS NULL)');
  } else if (keyVal === false || keyVal === 'false') {
    qb.addWhereRaw('has_errors = true');
  }

  qb.addOrder('has_errors', q.descending).addOrder('reported_date', q.descending).addPagination(q.limit, q.skip);

  const result = await qb.execute();
  const rows = result.rows.map(r => ({ id: r.id, key: [!r.has_errors], value: r.reported_date }));
  return formatResponse(rows, q);
};

const reports_by_verification = async (userCtx, rawQuery) => {
  const q = parseQuery(rawQuery);
  const qb = new QueryBuilder('reports')
    .addSelect(['id', 'verified', 'reported_date'])
    .addWhereRaw('form IS NOT NULL');

  const keyVal = q.key !== undefined ? keyFirst(q.key) : undefined;
  if (keyVal === true || keyVal === 'true') qb.addWhereRaw('verified = true');
  else if (keyVal === false || keyVal === 'false') qb.addWhereRaw('verified = false');
  else if (keyVal === null) qb.addWhereRaw('verified IS NULL');

  qb.addOrderRaw(`verified ${q.descending ? 'DESC NULLS LAST' : 'ASC NULLS FIRST'}`)
    .addOrder('reported_date', q.descending)
    .addPagination(q.limit, q.skip);

  const result = await qb.execute();
  const rows = result.rows.map(r => ({ id: r.id, key: [r.verified], value: r.reported_date }));
  return formatResponse(rows, q);
};

const tasks_by_contact = async (userCtx, rawQuery) => {
  const q = parseQuery(rawQuery);
  const key = q.key || q.startkey;

  // Determine query type from key format
  let queryType, queryValue;
  if (Array.isArray(key) && key[0] === 'owner' && key[1] === 'all') {
    queryType = 'owner-all';
    queryValue = key[2];
  } else if (typeof key === 'string') {
    if (key.startsWith('owner-')) {
      queryType = 'owner';
      queryValue = key.substring(6);
    } else if (key.startsWith('requester-')) {
      queryType = 'requester';
      queryValue = key.substring(10);
    }
  }

  const terminalStates = "('Cancelled', 'Completed', 'Failed')";
  let sql, params = [];

  if (queryType === 'owner') {
    sql = `SELECT id, COALESCE(owner, '_unassigned') as owner FROM tasks
           WHERE state IS NULL OR state NOT IN ${terminalStates}`;
    if (queryValue) { sql += ` AND COALESCE(owner, '_unassigned') = $1`; params.push(queryValue); }
    sql += ` ORDER BY owner`;
  } else if (queryType === 'requester') {
    sql = `SELECT id, requester FROM tasks WHERE requester IS NOT NULL`;
    if (queryValue) { sql += ` AND requester = $1`; params.push(queryValue); }
    sql += ` ORDER BY requester`;
  } else if (queryType === 'owner-all') {
    sql = `SELECT id, COALESCE(owner, '_unassigned') as owner, state FROM tasks`;
    if (queryValue) { sql += ` WHERE COALESCE(owner, '_unassigned') = $1`; params.push(queryValue); }
    sql += ` ORDER BY owner`;
  } else {
    // Return all emission types
    sql = `SELECT id, 'owner' as emit_type, COALESCE(owner, '_unassigned') as emit_value, state FROM tasks WHERE state IS NULL OR state NOT IN ${terminalStates}
           UNION ALL SELECT id, 'requester', requester, state FROM tasks WHERE requester IS NOT NULL
           UNION ALL SELECT id, 'owner-all', COALESCE(owner, '_unassigned'), state FROM tasks`;
  }

  if (q.limit) sql += ` LIMIT ${q.limit}`;
  if (q.skip) sql += ` OFFSET ${q.skip}`;

  const result = await postgres.pool.query(sql, params);
  const rows = result.rows.map(r => {
    if (r.emit_type === 'owner' || queryType === 'owner') return { id: r.id, key: 'owner-' + (r.owner || r.emit_value), value: null };
    if (r.emit_type === 'requester' || queryType === 'requester') return { id: r.id, key: 'requester-' + (r.requester || r.emit_value), value: null };
    return { id: r.id, key: ['owner', 'all', r.owner || r.emit_value], value: { state: r.state } };
  });
  return formatResponse(rows, q);
};

const docs_by_id_lineage = async (userCtx, rawQuery) => {
  const q = parseQuery(rawQuery);
  const key = q.key || q.startkey;

  if (!key || !Array.isArray(key) || !key[0]) {
    return formatResponse([], q);
  }

  const docId = key[0];
  const depth = key[1];

  // Query for contacts: emit the contact itself (depth 0) and all ancestors from lineage
  const contactSql = `
    SELECT id, 0 as depth, id as lineage_id
    FROM contacts
    WHERE id = $1
    UNION ALL
    SELECT c.id, idx + 1 as depth, lineage_ids.id as lineage_id
    FROM contacts c, unnest(c.lineage) WITH ORDINALITY AS lineage_ids(id, idx)
    WHERE c.id = $1
  `;

  // Query for reports: emit the report itself (depth 0) and contact's lineage (depth 1+)
  const reportSql = `
    SELECT r.id, 0 as depth, NULL as lineage_id
    FROM reports r
    WHERE r.id = $1 AND r.form IS NOT NULL
    UNION ALL
    SELECT r.id, idx + 1 as depth, lineage_ids.id as lineage_id
    FROM reports r
    JOIN contacts c ON r.contact = c.id
    CROSS JOIN unnest(c.lineage) WITH ORDINALITY AS lineage_ids(id, idx)
    WHERE r.id = $1 AND r.form IS NOT NULL
  `;

  // Combine both queries
  let sql = `
    SELECT * FROM (
      ${contactSql}
      UNION ALL
      ${reportSql}
    ) combined
    WHERE 1=1
  `;

  const params = [docId];
  let paramIdx = 2;

  // Filter by depth if specified
  if (depth !== undefined) {
    sql += ` AND depth = $${paramIdx++}`;
    params.push(depth);
  }

  sql += ` ORDER BY depth ${q.descending ? 'DESC' : 'ASC'}`;
  if (q.limit) sql += ` LIMIT ${q.limit}`;
  if (q.skip) sql += ` OFFSET ${q.skip}`;

  const result = await postgres.pool.query(sql, params);
  const rows = result.rows.map(r => ({
    id: r.id,
    key: [r.id, r.depth],
    value: r.lineage_id ? { _id: r.lineage_id } : null
  }));

  return formatResponse(rows, q);
};

const reports_by_place = async (userCtx, rawQuery) => {
  const q = parseQuery(rawQuery);

  // This view emits reports for each ancestor of the report's contact
  // Key is [place_id], value is reported_date
  const sql = `
    SELECT r.id, lineage_ids.id as place_id, r.reported_date
    FROM reports r
    JOIN contacts c ON r.contact = c.id
    CROSS JOIN unnest(c.lineage) AS lineage_ids(id)
    WHERE r.form IS NOT NULL
    ${q.key ? 'AND lineage_ids.id = $1' : ''}
    ${q.startkey ? 'AND lineage_ids.id >= $1' : ''}
    ${q.endkey ? 'AND lineage_ids.id <= $2' : ''}
    ORDER BY place_id ${q.descending ? 'DESC' : 'ASC'}, r.reported_date ${q.descending ? 'DESC' : 'ASC'}
    ${q.limit ? `LIMIT ${q.limit}` : ''} ${q.skip ? `OFFSET ${q.skip}` : ''}
  `;

  const params = [];
  if (q.key) params.push(keyFirst(q.key));
  else {
    if (q.startkey) params.push(keyFirst(q.startkey));
    if (q.endkey) params.push(keyFirst(q.endkey));
  }

  const result = await postgres.pool.query(sql, params);
  const rows = result.rows.map(r => ({
    id: r.id,
    key: [r.place_id],
    value: r.reported_date
  }));

  return formatResponse(rows, q);
};

const contacts_by_place = async (userCtx, rawQuery) => {
  const q = parseQuery(rawQuery);

  // This view emits contacts for each ancestor in their lineage
  // Key is [place_id], value is ordering string
  const sql = `
    SELECT c.id, lineage_ids.id as place_id, c.contact_type, c.name
    FROM contacts c
    CROSS JOIN unnest(c.lineage) AS lineage_ids(id)
    WHERE c.contact_type IS NOT NULL
    ${q.key ? 'AND lineage_ids.id = $1' : ''}
    ${q.startkey ? 'AND lineage_ids.id >= $1' : ''}
    ${q.endkey ? 'AND lineage_ids.id <= $2' : ''}
    ORDER BY place_id ${q.descending ? 'DESC' : 'ASC'}
    ${q.limit ? `LIMIT ${q.limit}` : ''} ${q.skip ? `OFFSET ${q.skip}` : ''}
  `;

  const params = [];
  if (q.key) params.push(keyFirst(q.key));
  else {
    if (q.startkey) params.push(keyFirst(q.startkey));
    if (q.endkey) params.push(keyFirst(q.endkey));
  }

  const result = await postgres.pool.query(sql, params);

  // Build the ordering string to match CouchDB view behavior
  const types = ['district_hospital', 'health_center', 'clinic', 'person'];
  const rows = result.rows.map(r => {
    let idx = types.indexOf(r.contact_type);
    if (idx === -1) idx = r.contact_type;
    const order = `${idx} ${(r.name || '').toLowerCase()}`;
    return {
      id: r.id,
      key: [r.place_id],
      value: order
    };
  });

  return formatResponse(rows, q);
};

// Map of view names to postgres implementations
// Views are now in sql_views.js for simplicity
const views = sqlViews;

// Fallback to CouchDB for views not implemented in postgres
const queryCouchDBView = async (viewName, query) => {
  const options = { ...query };
  if (options.include_docs === 'true') options.include_docs = true;
  if (options.include_docs === 'false') options.include_docs = false;
  return db.medic.query(`medic-client/${viewName}`, options);
};

module.exports = {
  request: async (req, res) => {
    const viewName = req.params.viewName;
    const viewFunction = views[viewName];

    logger.debug(`View request: ${viewName}, query: ${JSON.stringify(req.parsedQuery)}`);

    try {
      let result;
      if (viewFunction) {
        result = await viewFunction(req.userCtx, req.parsedQuery, req.body);
        logger.debug(`View ${viewName} (postgres) returned ${result.rows.length} rows`);
      } else {
        result = await queryCouchDBView(viewName, req.parsedQuery);
        logger.debug(`View ${viewName} (couchdb) returned ${result.rows.length} rows`);
      }
      return res.json(result);
    } catch (err) {
      logger.error(`View ${viewName} error: %o`, err);
      return serverUtils.serverError(err, req, res);
    }
  }
};
