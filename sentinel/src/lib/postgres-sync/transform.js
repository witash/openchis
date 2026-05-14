// Thin re-export. The canonical transform now lives in @medic/postgres-sync;
// sentinel keeps this file so existing callers (and tests asserting against the
// in-tree path) keep working.
module.exports = require('@medic/postgres-sync');
