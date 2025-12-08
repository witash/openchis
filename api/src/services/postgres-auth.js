const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const logger = require('@medic/logger');

// Session expires after 10 minutes of inactivity (same as CouchDB default)
const SESSION_TIMEOUT = 10 * 60 * 1000;

/**
 * Validates a password against a user document's stored credentials
 * Implements PBKDF2 password validation matching CouchDB's algorithm
 */
const validatePassword = (password, userDoc) => {
  if (!userDoc || !password) {
    return false;
  }

  const {
    password_scheme,
    pbkdf2_prf,
    salt,
    iterations,
    derived_key
  } = userDoc;

  // Only support pbkdf2 scheme (CouchDB's default)
  if (password_scheme !== 'pbkdf2') {
    logger.warn(`Unsupported password scheme: ${password_scheme}`);
    return false;
  }

  // Determine the hash algorithm (sha256 is CouchDB's default)
  const algorithm = pbkdf2_prf === 'sha256' ? 'sha256' : 'sha1';

  try {
    // Derive key from password using same parameters as stored
    const derivedKey = crypto.pbkdf2Sync(
      password,
      salt,
      parseInt(iterations),
      32, // 32 bytes = 256 bits
      algorithm
    );

    // Compare derived key with stored key
    const derivedKeyHex = derivedKey.toString('hex');
    return derivedKeyHex === derived_key;
  } catch (err) {
    logger.error('Error validating password: %o', err);
    return false;
  }
};

/**
 * Creates a new session for a user
 * @param {string} username - The username
 * @param {object} userDoc - The user document from postgres
 * @returns {string} - The session ID (cookie value)
 */
const createSession = async (username, userDoc) => {
  const sessionId = uuidv4();
  const now = Date.now();
  const expiresAt = now + SESSION_TIMEOUT;

  // Build userCtx object (same format as CouchDB)
  const userCtx = {
    name: username,
    roles: userDoc.roles || []
  };

  await db.postgres.query(
    'INSERT INTO sessions (session_id, username, created_at, expires_at, user_ctx) VALUES ($1, $2, $3, $4, $5)',
    [sessionId, username, now, expiresAt, JSON.stringify(userCtx)]
  );

  logger.debug(`Created session ${sessionId} for user ${username}`);
  return sessionId;
};

/**
 * Validates a session and returns the user context
 * @param {string} sessionId - The session ID from cookie
 * @returns {object|null} - The userCtx if session is valid, null otherwise
 */
const validateSession = async (sessionId) => {
  if (!sessionId) {
    return null;
  }

  try {
    const result = await db.postgres.query(
      'SELECT username, expires_at, user_ctx FROM sessions WHERE session_id = $1',
      [sessionId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const session = result.rows[0];
    const now = Date.now();

    // Check if session has expired
    if (now > session.expires_at) {
      // Delete expired session
      await db.postgres.query('DELETE FROM sessions WHERE session_id = $1', [sessionId]);
      return null;
    }

    // Update expiration time (extend session on activity)
    const newExpiresAt = now + SESSION_TIMEOUT;
    await db.postgres.query(
      'UPDATE sessions SET expires_at = $1 WHERE session_id = $2',
      [newExpiresAt, sessionId]
    );

    return session.user_ctx;
  } catch (err) {
    logger.error('Error validating session: %o', err);
    return null;
  }
};

/**
 * Deletes a session (logout)
 * @param {string} sessionId - The session ID to delete
 */
const deleteSession = async (sessionId) => {
  if (!sessionId) {
    return;
  }

  try {
    await db.postgres.query('DELETE FROM sessions WHERE session_id = $1', [sessionId]);
    logger.debug(`Deleted session ${sessionId}`);
  } catch (err) {
    logger.error('Error deleting session: %o', err);
  }
};

/**
 * Cleans up expired sessions (should be called periodically)
 */
const cleanupExpiredSessions = async () => {
  const now = Date.now();
  try {
    const result = await db.postgres.query(
      'DELETE FROM sessions WHERE expires_at < $1',
      [now]
    );
    if (result.rowCount > 0) {
      logger.debug(`Cleaned up ${result.rowCount} expired sessions`);
    }
  } catch (err) {
    logger.error('Error cleaning up expired sessions: %o', err);
  }
};

/**
 * Gets user document from postgres by username
 * @param {string} username - The username
 * @returns {object|null} - The user document if found, null otherwise
 */
const getUserDoc = async (username) => {
  try {
    const result = await db.postgres.query(
      'SELECT doc FROM users WHERE doc->>\'name\' = $1 ORDER BY seq DESC LIMIT 1',
      [username]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0].doc;
  } catch (err) {
    logger.error('Error getting user doc: %o', err);
    return null;
  }
};

/**
 * Authenticates a user with username and password
 * Creates a session if authentication is successful
 * @param {string} username - The username
 * @param {string} password - The password
 * @returns {string|null} - The session ID if successful, null otherwise
 */
const authenticate = async (username, password) => {
  const userDoc = await getUserDoc(username);

  if (!userDoc) {
    logger.debug(`User not found: ${username}`);
    return null;
  }

  if (!validatePassword(password, userDoc)) {
    logger.debug(`Invalid password for user: ${username}`);
    return null;
  }

  return await createSession(username, userDoc);
};

// Start periodic cleanup of expired sessions (every 5 minutes)
if (!process.env.UNIT_TEST_ENV) {
  setInterval(cleanupExpiredSessions, 5 * 60 * 1000);
}

module.exports = {
  validatePassword,
  createSession,
  validateSession,
  deleteSession,
  cleanupExpiredSessions,
  getUserDoc,
  authenticate
};
