const { parseQueryParams, addPagination, formatResponse, getUserContactId, postgres } = require('./utils');

// Parse the key to determine query type and value
const parseTaskKey = (key) => {
  if (!key) return null;

  if (typeof key === 'string') {
    if (key.startsWith('owner-')) {
      return { type: 'owner', value: key.substring(6) };
    }
    if (key.startsWith('requester-')) {
      return { type: 'requester', value: key.substring(10) };
    }
  } else if (Array.isArray(key) && key[0] === 'owner' && key[1] === 'all') {
    return { type: 'owner-all', value: key[2] };
  }

  return null;
};

const buildQuery = (userContactId, keys, include_docs, limit, skip) => {
  if (!keys || keys.length === 0) {
    return null;
  }

  const parsedKey = parseTaskKey(keys[0]);
  if (!parsedKey) {
    return null;
  }

  const { type, value } = parsedKey;
  const terminalStates = ['Cancelled', 'Completed', 'Failed'];

  let sql = '';
  const params = [];

  if (type === 'owner') {
    sql = `
      SELECT
        t.id,
        COALESCE(t.owner, '_unassigned') as owner,
        t.state
        ${include_docs ? ', d.doc' : ''}
      FROM tasks t
      ${include_docs ? 'INNER JOIN medic_documents d ON d._id = t.id' : ''}
      WHERE (t.state IS NULL OR t.state NOT IN ('${terminalStates.join("','")}'))
    `;

    if (value) {
      sql += ` AND COALESCE(t.owner, '_unassigned') = $1`;
      params.push(value);
    }

    sql += ` ORDER BY t.owner ASC`;

  } else if (type === 'requester') {
    sql = `
      SELECT
        t.id,
        t.requester,
        t.state
        ${include_docs ? ', d.doc' : ''}
      FROM tasks t
      ${include_docs ? 'INNER JOIN medic_documents d ON d._id = t.id' : ''}
      WHERE t.requester IS NOT NULL
    `;

    if (value) {
      sql += ` AND t.requester = $1`;
      params.push(value);
    }

    sql += ` ORDER BY t.requester ASC`;

  } else if (type === 'owner-all') {
    sql = `
      SELECT
        t.id,
        COALESCE(t.owner, '_unassigned') as owner,
        t.state
        ${include_docs ? ', d.doc' : ''}
      FROM tasks t
      ${include_docs ? 'INNER JOIN medic_documents d ON d._id = t.id' : ''}
      WHERE 1=1
    `;

    if (value) {
      sql += ` AND COALESCE(t.owner, '_unassigned') = $1`;
      params.push(value);
    }

    sql += ` ORDER BY t.owner ASC`;
  }

  sql = addPagination(sql, limit, skip);

  return { sql, params };
};

const formatRows = (dbRows, keyType, include_docs) => {
  return dbRows.map(r => {
    let key, value;

    if (keyType === 'owner') {
      key = 'owner-' + r.owner;
      value = null;
    } else if (keyType === 'requester') {
      key = 'requester-' + r.requester;
      value = null;
    } else if (keyType === 'owner-all') {
      key = ['owner', 'all', r.owner];
      value = { state: r.state };
    }

    const row = { id: r.id, key, value };

    if (include_docs && r.doc) {
      row.doc = r.doc;
    }

    return row;
  });
};

// tasks_by_contact view
// Key: 'owner-{id}', 'requester-{id}', or ['owner', 'all', {id}]
// Value: null or {state} for owner-all
const tasks_by_contact = async (userCtx, query) => {
  const { keys, include_docs, limit, skip } = parseQueryParams(query);
  const userContactId = getUserContactId(userCtx);

  const queryData = buildQuery(userContactId, keys, include_docs, limit, skip);
  if (!queryData) {
    return formatResponse([], query);
  }

  const { sql, params } = queryData;
  const result = await postgres.pool.query(sql, params);

  const parsedKey = parseTaskKey(keys[0]);
  const rows = formatRows(result.rows, parsedKey.type, include_docs);

  return formatResponse(rows, query);
};

module.exports = tasks_by_contact;
