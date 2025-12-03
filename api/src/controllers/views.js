const db = require('../db');
const serverUtils = require('../server-utils');
const logger = require('@medic/logger');

// Helper to format CouchDB-compatible view response
const formatViewResponse = (rows, totalRows) => ({
  total_rows: totalRows || rows.length,
  offset: 0,
  rows: rows
});

// Postgres-backed view queries
// Each function corresponds to a CouchDB map-reduce view
const views = {
  // docs_by_id_lineage: Returns a document and its contact lineage
  // For contacts: emits contact and parent hierarchy with depth
  // For reports: emits report at depth 0, then contact lineage from depth 1
  docs_by_id_lineage: async (userCtx, query) => {
    const startkey = query?.startkey;
    const endkey = query?.endkey;
    const includeDocs = query?.include_docs === 'true' || query?.include_docs === true;

    if (!startkey || !Array.isArray(startkey) || startkey.length === 0) {
      return formatViewResponse([]);
    }

    const docId = startkey[0];
    const rows = [];

    // Get the document
    const docResult = await db.postgres.query(
      'SELECT doc FROM medic_documents WHERE _id = $1 ORDER BY timestamp DESC LIMIT 1',
      [docId]
    );

    if (docResult.rows.length === 0) {
      return formatViewResponse([]);
    }

    const doc = docResult.rows[0].doc;

    // For contacts, walk the entire lineage from the contact itself
    if (['contact', 'person', 'health_center', 'district_hospital', 'clinic'].includes(doc.type)) {
      // Depth 0: the contact itself
      rows.push({
        key: [docId, 0],
        id: docId,
        value: { _id: docId },
        ...(includeDocs && { doc: doc })
      });

      // Depth 1+: parent lineage
      const contactResult = await db.postgres.query(
        `WITH RECURSIVE lineage AS (
          SELECT id, parent, 0 as depth FROM contacts WHERE id = $1
          UNION ALL
          SELECT c.id, c.parent, l.depth + 1
          FROM contacts c
          JOIN lineage l ON c.id = l.parent
          WHERE l.depth < 10
        )
        SELECT l.id, l.depth FROM lineage l WHERE l.depth > 0 ORDER BY l.depth`,
        [docId]
      );

      for (const row of contactResult.rows) {
        const parentDoc = includeDocs ? (await db.postgres.query(
          'SELECT doc FROM medic_documents WHERE _id = $1 ORDER BY timestamp DESC LIMIT 1',
          [row.id]
        )).rows[0]?.doc : undefined;

        rows.push({
          key: [docId, row.depth],
          id: docId,
          value: { _id: row.id },
          ...(includeDocs && parentDoc && { doc: parentDoc })
        });
      }
    }

    // For reports, depth 0 is the report, depth 1+ is contact lineage
    else if (doc.type === 'data_record' && doc.form) {
      // Depth 0: the report itself
      rows.push({
        key: [docId, 0],
        id: docId,
        value: null,
        ...(includeDocs && { doc: doc })
      });

      const contactId = doc.contact?._id || doc.contact;
      if (contactId) {
        const contactResult = await db.postgres.query(
          `WITH RECURSIVE lineage AS (
            SELECT id, parent, 1 as depth FROM contacts WHERE id = $1
            UNION ALL
            SELECT c.id, c.parent, l.depth + 1
            FROM contacts c
            JOIN lineage l ON c.id = l.parent
            WHERE l.depth < 10
          )
          SELECT l.id, l.depth FROM lineage l ORDER BY l.depth`,
          [contactId]
        );

        for (const row of contactResult.rows) {
          const parentDoc = includeDocs ? (await db.postgres.query(
            'SELECT doc FROM medic_documents WHERE _id = $1 ORDER BY timestamp DESC LIMIT 1',
            [row.id]
          )).rows[0]?.doc : undefined;

          rows.push({
            key: [docId, row.depth],
            id: docId,
            value: { _id: row.id },
            ...(includeDocs && parentDoc && { doc: parentDoc })
          });
        }
      }
    }

    return formatViewResponse(rows);
  },

  // contacts_by_parent: Returns contacts filtered by parent ID and type
  contacts_by_parent: async (userCtx, query) => {
    const includeDocs = query?.include_docs === 'true' || query?.include_docs === true;

    const selectFields = includeDocs
      ? 'md._id as id, c.parent, COALESCE((md.doc->>\'contact_type\'), md.doc->>\'type\') as contact_type, md.doc'
      : 'md._id as id, c.parent, COALESCE((md.doc->>\'contact_type\'), md.doc->>\'type\') as contact_type';

    let sql = `
      SELECT ${selectFields}
      FROM medic_documents md
      JOIN contacts c ON c.id = md._id
      WHERE 1=1
    `;

    const params = [];

    // Handle key or keys parameter [parentId, type]
    const key = query?.key;
    const keys = query?.keys;

    if (keys && Array.isArray(keys)) {
      // keys is an array of [parentId, type] arrays
      // For simplicity, we'll just use the first key for now
      const targetKey = keys[0];
      if (targetKey && Array.isArray(targetKey)) {
        if (targetKey[0]) {
          params.push(targetKey[0]);
          sql += ` AND c.parent = $${params.length}`;
        }
        if (targetKey[1]) {
          params.push(targetKey[1]);
          sql += ` AND COALESCE((md.doc->>'contact_type'), md.doc->>'type') = $${params.length}`;
        }
      }
    } else if (key && Array.isArray(key)) {
      if (key[0]) {
        params.push(key[0]);
        sql += ` AND c.parent = $${params.length}`;
      }
      if (key[1]) {
        params.push(key[1]);
        sql += ` AND COALESCE((md.doc->>'contact_type'), md.doc->>'type') = $${params.length}`;
      }
    }

    // Handle startkey/endkey for range queries
    // Pattern: startkey=["parentId"] endkey=["parentId",{}] means all contacts with that parent
    if (query?.startkey && Array.isArray(query.startkey)) {
      if (query.startkey[0]) {
        params.push(query.startkey[0]);
        sql += ` AND c.parent = $${params.length}`;
      }
    }

    sql += ` ORDER BY c.parent, contact_type`;

    if (query?.limit) {
      params.push(parseInt(query.limit));
      sql += ` LIMIT $${params.length}`;
    }

    const result = await db.postgres.query(sql, params);

    const rows = result.rows.map(row => ({
      key: [row.parent, row.contact_type],
      id: row.id,
      value: null,
      ...(includeDocs && row.doc && { doc: row.doc })
    }));

    return formatViewResponse(rows);
  },

  // reports_by_subject: Returns reports filtered by subject (patient_id, place_id, etc.)
  reports_by_subject: async (userCtx, query) => {
    const key = query?.key;
    const keys = query?.keys;
    const includeDocs = query?.include_docs === 'true' || query?.include_docs === true;

    const targetKey = keys && Array.isArray(keys) && keys.length > 0 ? keys[0] : key;

    if (!targetKey) {
      return formatViewResponse([]);
    }

    const selectFields = includeDocs
      ? 'md._id as id, r.subject, (md.doc->>\'reported_date\')::bigint as reported_date, md.doc'
      : 'md._id as id, r.subject, (md.doc->>\'reported_date\')::bigint as reported_date';

    // Query reports table by subject or extract from doc JSONB
    let sql = `
      SELECT ${selectFields}
      FROM medic_documents md
      JOIN reports r ON r.id = md._id
      WHERE (
        r.subject = $1
        OR md.doc->>'patient_id' = $1
        OR md.doc->>'place_id' = $1
        OR md.doc->>'case_id' = $1
        OR md.doc->'fields'->>'patient_id' = $1
        OR md.doc->'fields'->>'place_id' = $1
        OR md.doc->'fields'->>'case_id' = $1
        OR md.doc->'fields'->>'patient_uuid' = $1
        OR md.doc->'fields'->>'place_uuid' = $1
      )
      ORDER BY reported_date DESC
    `;

    const params = [targetKey];

    if (query?.limit) {
      params.push(parseInt(query.limit));
      sql += ` LIMIT $${params.length}`;
    }

    const result = await db.postgres.query(sql, params);

    const rows = result.rows.map(row => ({
      key: row.subject || targetKey,
      id: row.id,
      value: row.reported_date,
      ...(includeDocs && row.doc && { doc: row.doc })
    }));

    return formatViewResponse(rows);
  },

  // contacts_by_reference: Returns contacts by reference (shortcode or external ID)
  contacts_by_reference: async (userCtx, query) => {
    const key = query?.key;
    const keys = query?.keys;
    const includeDocs = query?.include_docs === 'true' || query?.include_docs === true;

    const targetKey = keys && Array.isArray(keys) && keys.length > 0 ? keys[0] : key;

    if (!targetKey || !Array.isArray(targetKey) || targetKey.length !== 2) {
      return formatViewResponse([]);
    }

    const [prefix, reference] = targetKey;

    const selectFields = includeDocs
      ? 'md._id as id, (md.doc->>\'reported_date\')::bigint as reported_date, md.doc'
      : 'md._id as id, (md.doc->>\'reported_date\')::bigint as reported_date';

    let sql = `
      SELECT ${selectFields}
      FROM medic_documents md
      WHERE md.doc->>'type' IN ('contact', 'person', 'health_center', 'district_hospital', 'clinic', 'national_office')
    `;

    const params = [];

    if (prefix === 'shortcode') {
      params.push(reference);
      sql += ` AND (md.doc->>'place_id' = $${params.length} OR md.doc->>'patient_id' = $${params.length})`;
    } else if (prefix === 'external') {
      params.push(reference.toUpperCase());
      sql += ` AND UPPER(md.doc->>'rc_code') = $${params.length}`;
    }

    sql += ` ORDER BY reported_date DESC`;

    if (query?.limit) {
      params.push(parseInt(query.limit));
      sql += ` LIMIT $${params.length}`;
    }

    const result = await db.postgres.query(sql, params);

    const rows = result.rows.map(row => ({
      key: [prefix, reference],
      id: row.id,
      value: row.reported_date,
      ...(includeDocs && row.doc && { doc: row.doc })
    }));

    return formatViewResponse(rows);
  },

  // data_records_by_type: Returns data_record documents categorized as 'report' or 'message'
  // Reports have a form field, messages do not
  data_records_by_type: async (userCtx, query) => {
    const includeDocs = query?.include_docs === 'true' || query?.include_docs === true;

    const selectFields = includeDocs
      ? 'md._id as id, CASE WHEN md.doc->\'form\' IS NOT NULL THEN \'report\' ELSE \'message\' END as record_type, md.doc'
      : 'md._id as id, CASE WHEN md.doc->\'form\' IS NOT NULL THEN \'report\' ELSE \'message\' END as record_type';

    let sql = `
      SELECT ${selectFields}
      FROM medic_documents md
      WHERE md.doc->>'type' = 'data_record'
    `;

    const params = [];

    // Handle key or keys parameter to filter by type
    const key = query?.key;
    const keys = query?.keys;

    const targetKey = keys && Array.isArray(keys) && keys.length > 0 ? keys[0] : key;

    if (targetKey) {
      if (targetKey === 'report') {
        sql += ` AND md.doc->'form' IS NOT NULL`;
      } else if (targetKey === 'message') {
        sql += ` AND md.doc->'form' IS NULL`;
      }
    }

    sql += ` ORDER BY md._id`;

    if (query?.limit) {
      params.push(parseInt(query.limit));
      sql += ` LIMIT $${params.length}`;
    }

    const result = await db.postgres.query(sql, params);

    const rows = result.rows.map(row => ({
      key: row.record_type,
      id: row.id,
      value: null,
      ...(includeDocs && row.doc && { doc: row.doc })
    }));

    return formatViewResponse(rows);
  },

  // doc_by_type: Returns all documents grouped by their type
  doc_by_type: async (userCtx, query) => {
    const includeDocs = query?.include_docs === 'true' || query?.include_docs === true;

    const selectFields = includeDocs
      ? 'md._id as id, md.doc->>\'type\' as type, md.doc'
      : 'md._id as id, md.doc->>\'type\' as type';

    let sql = `
      SELECT ${selectFields}
      FROM medic_documents md
      WHERE md.doc->>'type' IS NOT NULL
    `;

    const params = [];

    // Handle key or keys parameter to filter by specific type(s)
    const key = query?.key;
    const keys = query?.keys;

    if (keys && Array.isArray(keys)) {
      // keys is an array of type arrays, e.g., [["contact"], ["person"]]
      const docTypes = keys.map(k => Array.isArray(k) ? k[0] : k);
      params.push(docTypes);
      sql += ` AND md.doc->>'type' = ANY($${params.length})`;
    } else if (key) {
      const docType = Array.isArray(key) ? key[0] : key;
      params.push(docType);
      sql += ` AND md.doc->>'type' = $${params.length}`;
    }

    // Handle startkey/endkey for range queries
    if (query?.startkey) {
      const startType = Array.isArray(query.startkey) ? query.startkey[0] : query.startkey;
      params.push(startType);
      sql += ` AND md.doc->>'type' >= $${params.length}`;
    }

    if (query?.endkey) {
      const endType = Array.isArray(query.endkey) ? query.endkey[0] : query.endkey;
      params.push(endType);
      sql += ` AND md.doc->>'type' <= $${params.length}`;
    }

    sql += ` ORDER BY type, md._id`;

    if (query?.limit) {
      params.push(parseInt(query.limit));
      sql += ` LIMIT $${params.length}`;
    }

    const result = await db.postgres.query(sql, params);

    const rows = result.rows.map(row => ({
      key: [row.type],
      id: row.id,
      value: null,
      ...(includeDocs && row.doc && { doc: row.doc })
    }));

    return formatViewResponse(rows);
  },

  // reports_by_date: Returns reports ordered by reported_date
  reports_by_date: async (userCtx, query) => {
    const includeDocs = query?.include_docs === 'true' || query?.include_docs === true;

    const selectFields = includeDocs
      ? 'md._id as id, (md.doc->>\'reported_date\')::bigint as reported_date, md.doc'
      : 'md._id as id, (md.doc->>\'reported_date\')::bigint as reported_date';

    let sql = `
      SELECT ${selectFields}
      FROM medic_documents md
      WHERE md.doc->>'type' = 'data_record'
        AND md.doc->'form' IS NOT NULL
    `;

    const params = [];

    // Handle key parameter (single date)
    const key = query?.key;
    const keys = query?.keys;

    if (keys && Array.isArray(keys)) {
      // keys is an array of date arrays
      const dates = keys.map(k => Array.isArray(k) ? k[0] : k);
      params.push(dates);
      sql += ` AND (md.doc->>'reported_date')::bigint = ANY($${params.length})`;
    } else if (key) {
      const date = Array.isArray(key) ? key[0] : key;
      params.push(date);
      sql += ` AND (md.doc->>'reported_date')::bigint = $${params.length}`;
    }

    // Handle startkey/endkey for date range queries
    if (query?.startkey) {
      const startDate = Array.isArray(query.startkey) ? query.startkey[0] : query.startkey;
      if (startDate) {
        params.push(startDate);
        sql += ` AND (md.doc->>'reported_date')::bigint >= $${params.length}`;
      }
    }

    if (query?.endkey) {
      const endDate = Array.isArray(query.endkey) ? query.endkey[0] : query.endkey;
      if (endDate) {
        params.push(endDate);
        sql += ` AND (md.doc->>'reported_date')::bigint <= $${params.length}`;
      }
    }

    // Order by reported_date descending (most recent first)
    sql += ` ORDER BY reported_date DESC`;

    if (query?.limit) {
      params.push(parseInt(query.limit));
      sql += ` LIMIT $${params.length}`;
    }

    const result = await db.postgres.query(sql, params);

    const rows = result.rows.map(row => ({
      key: [row.reported_date],
      id: row.id,
      value: row.reported_date,
      ...(includeDocs && row.doc && { doc: row.doc })
    }));

    return formatViewResponse(rows);
  },

  // contacts_by_type: Returns contacts of specific types with special ordering
  // Ordering: dead status, muted status, type priority, then alphabetically by name
  contacts_by_type: async (userCtx, query) => {
    const includeDocs = query?.include_docs === 'true' || query?.include_docs === true;

    const selectFields = includeDocs
      ? `md._id as id,
        c.contact_type,
        COALESCE((md.doc->>'date_of_death')::boolean, false) as dead,
        COALESCE((md.doc->>'muted')::boolean, false) as muted,
        LOWER(md.doc->>'name') as name_lower,
        CASE
          WHEN c.contact_type = 'district_hospital' THEN '0'
          WHEN c.contact_type = 'health_center' THEN '1'
          WHEN c.contact_type = 'clinic' THEN '2'
          WHEN c.contact_type = 'person' THEN '3'
          ELSE c.contact_type
        END as type_idx,
        md.doc`
      : `md._id as id,
        c.contact_type,
        COALESCE((md.doc->>'date_of_death')::boolean, false) as dead,
        COALESCE((md.doc->>'muted')::boolean, false) as muted,
        LOWER(md.doc->>'name') as name_lower,
        CASE
          WHEN c.contact_type = 'district_hospital' THEN '0'
          WHEN c.contact_type = 'health_center' THEN '1'
          WHEN c.contact_type = 'clinic' THEN '2'
          WHEN c.contact_type = 'person' THEN '3'
          ELSE c.contact_type
        END as type_idx`;

    let sql = `
      SELECT ${selectFields}
      FROM medic_documents md
      JOIN contacts c ON c.id = md._id
      WHERE c.contact_type IS NOT NULL
    `;

    const params = [];

    // Handle key or keys parameter to filter by specific contact type(s)
    const key = query?.key;
    const keys = query?.keys;
    logger.info(`contacts_by_type: query = ${JSON.stringify(query)}`);
    logger.info(`contacts_by_type: key = ${JSON.stringify(key)}, keys = ${JSON.stringify(keys)}`);

    if (keys && Array.isArray(keys)) {
      // keys is an array of key arrays, e.g., [["district_hospital"], ["person"]]
      const contactTypes = keys.map(k => Array.isArray(k) ? k[0] : k);
      logger.info(`contacts_by_type: filtering by contactTypes = ${JSON.stringify(contactTypes)}`);
      params.push(contactTypes);
      sql += ` AND c.contact_type = ANY($${params.length})`;
    } else if (key) {
      const contactType = Array.isArray(key) ? key[0] : key;
      logger.info(`contacts_by_type: filtering by contactType = ${contactType}`);
      params.push(contactType);
      sql += ` AND c.contact_type = $${params.length}`;
    }

    // Order by: dead, muted, type index, then name
    sql += ` ORDER BY dead, muted, type_idx, name_lower`;

    if (query?.limit) {
      params.push(parseInt(query.limit));
      sql += ` LIMIT $${params.length}`;
    }

    logger.info(`contacts_by_type: SQL = ${sql}`);
    logger.info(`contacts_by_type: params = ${JSON.stringify(params)}`);
    const result = await db.postgres.query(sql, params);

    const rows = result.rows.map(row => {
      // Build the ordering string like the CouchDB view
      const order = `${row.dead} ${row.muted} ${row.type_idx} ${row.name_lower || ''}`;
      return {
        key: [row.contact_type],
        id: row.id,
        value: order,
        ...(includeDocs && row.doc && { doc: row.doc })
      };
    });

    return formatViewResponse(rows);
  }
};

module.exports = {
  request: async (req, res) => {
    const viewName = req.params.viewName;
    const viewFunction = views[viewName];

    logger.info(`View request: ${viewName}, query: ${JSON.stringify(req.parsedQuery)}, body: ${JSON.stringify(req.body)}`);

    if (!viewFunction) {
      return res.status(404).json({
        error: 'not_found',
        reason: `View ${viewName} not found`
      });
    }

    try {
      const result = await viewFunction(req.userCtx, req.parsedQuery, req.body);
      logger.info(`View ${viewName} returned ${result.rows.length} rows`);
      return res.json(result);
    } catch (err) {
      logger.error(`View ${viewName} error: %o`, err);
      return serverUtils.serverError(err, req, res);
    }
  }
};
