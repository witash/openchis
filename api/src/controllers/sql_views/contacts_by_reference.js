const { parseQueryParams, addPagination, formatResponse, getUserContactId, postgres } = require('./utils');

// Parse the key to determine query type (shortcode or external)
const parseReferenceKey = (key) => {
  if (!key || !Array.isArray(key) || key.length < 1) {
    return null;
  }

  const prefix = key[0];
  const value = key[1];

  if (prefix === 'shortcode' || prefix === 'external') {
    return { prefix, value };
  }

  return null;
};

const buildQuery = (userContactId, keys, include_docs, limit, skip) => {
  if (!keys || keys.length === 0) {
    return null;
  }

  const parsedKey = parseReferenceKey(keys[0]);
  if (!parsedKey) {
    return null;
  }

  const { prefix, value } = parsedKey;
  const params = [userContactId];

  if (prefix === 'shortcode') {
    let sql = `
      SELECT
        c.id,
        c.shortcode
        ${include_docs ? ', d.doc' : ''}
      FROM contacts c
      ${include_docs ? 'INNER JOIN medic_documents d ON d._id = c.id' : ''}
      WHERE c.shortcode IS NOT NULL
        AND (c.lineage @> ARRAY[$1] OR c.id = $1)
    `;

    if (value) {
      sql += ` AND c.shortcode = $2`;
      params.push(value);
    }

    sql += ` ORDER BY c.shortcode ASC`;
    sql = addPagination(sql, limit, skip);

    return { sql, params, keyType: 'shortcode' };

  } else if (prefix === 'external') {
    let sql = `
      SELECT
        c.id,
        UPPER(d.doc->>'rc_code') as rc_code
        ${include_docs ? ', d.doc' : ''}
      FROM contacts c
      INNER JOIN medic_documents d ON d._id = c.id
      WHERE d.doc->>'rc_code' IS NOT NULL
        AND (c.lineage @> ARRAY[$1] OR c.id = $1)
    `;

    if (value) {
      sql += ` AND UPPER(d.doc->>'rc_code') = $2`;
      params.push(value.toUpperCase());
    }

    sql += ` ORDER BY UPPER(d.doc->>'rc_code') ASC`;
    sql = addPagination(sql, limit, skip);

    return { sql, params, keyType: 'external' };
  }

  return null;
};

const formatRows = (dbRows, keyType, include_docs) => {
  return dbRows.map(r => {
    let key;

    if (keyType === 'shortcode') {
      key = ['shortcode', r.shortcode];
    } else if (keyType === 'external') {
      key = ['external', r.rc_code];
    }

    const row = {
      id: r.id,
      key,
      value: null
    };

    if (include_docs && r.doc) {
      row.doc = r.doc;
    }

    return row;
  });
};

// contacts_by_reference view
// Key: ['shortcode', value] or ['external', value]
// Value: null
const contacts_by_reference = async (userCtx, query) => {
  const { keys, include_docs, limit, skip } = parseQueryParams(query);
  const userContactId = getUserContactId(userCtx);

  const queryData = buildQuery(userContactId, keys, include_docs, limit, skip);
  if (!queryData) {
    return formatResponse([], query);
  }

  const { sql, params, keyType } = queryData;
  const result = await postgres.pool.query(sql, params);
  const rows = formatRows(result.rows, keyType, include_docs);

  return formatResponse(rows, query);
};

module.exports = contacts_by_reference;
