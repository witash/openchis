const postgres = require('../../services/postgres');

// Parse key parameter (handles JSON strings)
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

// Parse common query parameters
const parseQueryParams = (query) => {
  const key = parseKey(query.key);
  const keys = parseKey(query.keys);

  // Normalize: key is just keys with one element
  const normalizedKeys = keys || (key ? [key] : null);

  return {
    keys: normalizedKeys,
    startkey: parseKey(query.startkey),
    endkey: parseKey(query.endkey),
    include_docs: query.include_docs === 'true' || query.include_docs === true,
    limit: query.limit ? parseInt(query.limit) : null,
    skip: query.skip ? parseInt(query.skip) : 0
  };
};

// Add LIMIT and OFFSET to SQL query
const addPagination = (sql, limit, skip) => {
  let result = sql;
  if (limit) {
    result += ` LIMIT ${limit}`;
  }
  if (skip) {
    result += ` OFFSET ${skip}`;
  }
  return result;
};

// Format response to match CouchDB view response format
const formatResponse = (rows, query) => {
  const response = {
    total_rows: rows.length,
    offset: 0,
    rows: rows
  };

  return response;
};

// Hardcoded user contact_id for testing authorization
const getUserContactId = (userCtx) => {
  return 'e4dba957-ee23-4a07-a82a-a1228b5d7364';
};

// Common formatting function for view rows
// getKey and getValue are functions that extract the key and value from a db row
const formatRows = (dbRows, getKey, getValue, include_docs) => {
  return dbRows.map(r => {
    const row = {
      id: r.id,
      key: getKey(r),
      value: getValue(r)
    };

    if (include_docs && r.doc) {
      row.doc = r.doc;
    }

    return row;
  });
};

// Common execution pattern for SQL views
// buildQuery, getKey, getValue are view-specific functions
// options: { requireKeys: boolean }
const executeView = async (userCtx, query, buildQuery, getKey, getValue, options = {}) => {
  const { keys, include_docs, limit, skip } = parseQueryParams(query);
  const userContactId = getUserContactId(userCtx);

  if (options.requireKeys && (!keys || keys.length === 0)) {
    return formatResponse([], query);
  }

  const { sql, params } = buildQuery(userContactId, keys, include_docs, limit, skip);
  const result = await postgres.pool.query(sql, params);
  const rows = formatRows(result.rows, getKey, getValue, include_docs);

  return formatResponse(rows, query);
};

module.exports = {
  parseKey,
  parseQueryParams,
  addPagination,
  formatResponse,
  formatRows,
  executeView,
  getUserContactId,
  postgres
};
