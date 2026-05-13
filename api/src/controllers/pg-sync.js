const pgSync = require('../services/pg-sync/pg-sync');
const serverUtils = require('../server-utils');

module.exports = {
  getDocs: async (req, res) => {
    if (!req.userCtx || !req.userCtx.name) {
      return serverUtils.notLoggedIn(req, res);
    }
    try {
      const since = req.body && req.body.since !== undefined ? req.body.since : 0;
      const result = await pgSync.getDocs(req.userCtx, since);
      return res.json(result);
    } catch (err) {
      return serverUtils.serverError(err, req, res);
    }
  },
};
