const rewire = require('rewire');
const fs = require('fs');
const path = require('path');
const chai = require('chai');

describe('Routing', () => {
  before(() => global.angular = {
    module: () => ({
      controller: () => {},
    }),
  });

  after(() => delete global.angular);

  it('Content Security policy build url matches actual', () => {
    const environment = rewire('@medic/environment');
    const adminUpgrade = rewire('./../../../admin/src/js/controllers/upgrade');
    const cspBuildDb = environment.__get__('DEFAULT_BUILDS_URL');
    const actualBuildDb = adminUpgrade.__get__('DEFAULT_BUILDS_URL');
    chai.expect(cspBuildDb).to.not.eq(undefined);
    chai.expect(cspBuildDb).to.include(actualBuildDb);
  });

  describe('/api/v1/pg-sync wiring', () => {
    // onlineUserPassThrough is what calls auth.getUserSettings to populate
    // facility_id/contact_id on req.userCtx. Without it the pg-sync handler
    // sees a bare CouchDB session and short-circuits to {docs:[], last_seq:N}.
    const routingSource = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'routing.js'),
      'utf8'
    );

    const pgSyncBlock = routingSource.match(/app\.post\(\s*'\/api\/v1\/pg-sync'[\s\S]*?\);/);

    it('the route declaration exists', () => {
      chai.expect(pgSyncBlock, 'pg-sync POST route not found in routing.js').to.not.be.null;
    });

    it('includes onlineUserPassThrough so facility_id/contact_id reach userCtx', () => {
      chai.expect(pgSyncBlock[0]).to.include('authorization.onlineUserPassThrough');
    });
  });
});
