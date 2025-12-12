const serverUtils = require('../server-utils');
const db = require('../db');

// Environment variable to control which sync protocol to use
// Set USE_POSTGRES_SYNC=true to enable postgres sync for all clients
const USE_POSTGRES_SYNC = process.env.USE_POSTGRES_SYNC === 'true';

module.exports = {
  /**
   * GET /api/v1/sync/info
   * Returns sync protocol info for the client.
   * - usePostgresSync: boolean indicating which protocol to use
   * - serverSeq: current max postgres sequence (for upgrade tracking)
   */
  get: async (req, res) => {
    try {
      // Get the current max postgres sequence for upgrade tracking
      let serverSeq = null;
      if (USE_POSTGRES_SYNC) {
        const result = await db.postgres.query('SELECT MAX(seq) as max_seq FROM medic_documents');
        serverSeq = result.rows[0]?.max_seq || 0;
      }

      return res.json({
        usePostgresSync: USE_POSTGRES_SYNC,
        serverSeq: serverSeq
      });
    } catch (err) {
      return serverUtils.serverError(err, req, res);
    }
  },

  /**
   * POST /api/v1/sync/upgrade
   * Store the client's PouchDB sequence when upgrading from Nairobi to postgres sync.
   * This allows resuming from where the Nairobi protocol left off.
   * Body: { pouchdb_seq: string }
   */
  postUpgradeSequence: async (req, res) => {
    try {
      const username = req.userCtx?.name;
      if (!username) {
        return serverUtils.error({ code: 401, message: 'Unauthorized' }, req, res);
      }

      const pouchdbSeq = req.body?.pouchdb_seq;
      if (pouchdbSeq === undefined) {
        return serverUtils.error({ code: 400, message: 'pouchdb_seq is required' }, req, res);
      }

      // Get current postgres sequence
      const seqResult = await db.postgres.query('SELECT MAX(seq) as max_seq FROM medic_documents');
      const postgresStartSeq = seqResult.rows[0]?.max_seq || 0;

      // Store or update the client's upgrade state
      await db.postgres.query(`
        INSERT INTO client_sync_state (username, pouchdb_upgrade_seq, postgres_start_seq)
        VALUES ($1, $2, $3)
        ON CONFLICT (username) DO UPDATE SET
          pouchdb_upgrade_seq = $2,
          postgres_start_seq = $3,
          created_at = NOW()
      `, [username, String(pouchdbSeq), postgresStartSeq]);

      return res.json({
        success: true,
        postgres_start_seq: postgresStartSeq
      });
    } catch (err) {
      return serverUtils.serverError(err, req, res);
    }
  },

  /**
   * GET /api/v1/sync/upgrade-state
   * Get the client's upgrade state (if any).
   * Returns the stored pouchdb_upgrade_seq and postgres_start_seq.
   */
  getUpgradeState: async (req, res) => {
    try {
      const username = req.userCtx?.name;
      if (!username) {
        return serverUtils.error({ code: 401, message: 'Unauthorized' }, req, res);
      }

      const result = await db.postgres.query(
        'SELECT pouchdb_upgrade_seq, postgres_start_seq, created_at FROM client_sync_state WHERE username = $1',
        [username]
      );

      if (result.rows.length === 0) {
        return res.json({ hasUpgradeState: false });
      }

      const row = result.rows[0];
      return res.json({
        hasUpgradeState: true,
        pouchdb_upgrade_seq: row.pouchdb_upgrade_seq,
        postgres_start_seq: row.postgres_start_seq,
        created_at: row.created_at
      });
    } catch (err) {
      return serverUtils.serverError(err, req, res);
    }
  }
};
