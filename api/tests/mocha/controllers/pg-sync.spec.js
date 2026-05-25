const { expect } = require('chai');
const sinon = require('sinon');

const controller = require('../../../src/controllers/pg-sync');
const pgSync = require('../../../src/services/pg-sync/pg-sync');
const serverUtils = require('../../../src/server-utils');

const makeRes = () => ({
  json: sinon.stub(),
  status: sinon.stub().returnsThis(),
});

describe('pg-sync controller', () => {
  afterEach(() => sinon.restore());

  it('returns docs from the service', async () => {
    sinon.stub(pgSync, 'getDocs').resolves({
      docs: [{ _id: 'd1', _rev: '1-a' }],
    });
    const req = { userCtx: { name: 'alice', contact_id: 'c1' } };
    const res = makeRes();

    await controller.getDocs(req, res);

    expect(pgSync.getDocs.args).to.deep.equal([[req.userCtx]]);
    expect(res.json.args).to.deep.equal([[{
      docs: [{ _id: 'd1', _rev: '1-a' }],
    }]]);
  });

  it('rejects unauthenticated requests (no userCtx)', async () => {
    const notLoggedIn = sinon.stub(serverUtils, 'notLoggedIn');
    const getDocs = sinon.stub(pgSync, 'getDocs');
    const req = {};
    const res = makeRes();

    await controller.getDocs(req, res);

    expect(notLoggedIn.callCount).to.equal(1);
    expect(getDocs.callCount).to.equal(0);
  });

  it('rejects unauthenticated requests (userCtx without name)', async () => {
    const notLoggedIn = sinon.stub(serverUtils, 'notLoggedIn');
    const getDocs = sinon.stub(pgSync, 'getDocs');
    const req = { userCtx: {} };
    const res = makeRes();

    await controller.getDocs(req, res);

    expect(notLoggedIn.callCount).to.equal(1);
    expect(getDocs.callCount).to.equal(0);
  });

  it('routes service errors to serverUtils.serverError', async () => {
    sinon.stub(pgSync, 'getDocs').rejects(new Error('boom'));
    const serverError = sinon.stub(serverUtils, 'serverError');
    const req = { userCtx: { name: 'alice', contact_id: 'c1' } };
    const res = makeRes();

    await controller.getDocs(req, res);

    expect(serverError.callCount).to.equal(1);
    expect(serverError.args[0][0]).to.be.an('error');
  });
});
