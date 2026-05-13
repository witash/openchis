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

  it('returns docs + last_seq from the service', async () => {
    sinon.stub(pgSync, 'getDocs').resolves({
      docs: [{ _id: 'd1', _rev: '1-a' }],
      last_seq: 42,
    });
    const req = { userCtx: { name: 'alice', contact_id: 'c1' }, body: { since: 10 } };
    const res = makeRes();

    await controller.getDocs(req, res);

    expect(pgSync.getDocs.args).to.deep.equal([[req.userCtx, 10]]);
    expect(res.json.args).to.deep.equal([[{
      docs: [{ _id: 'd1', _rev: '1-a' }],
      last_seq: 42,
    }]]);
  });

  it('defaults `since` to 0 when not provided', async () => {
    sinon.stub(pgSync, 'getDocs').resolves({ docs: [], last_seq: 0 });
    const req = { userCtx: { name: 'alice', contact_id: 'c1' } };
    const res = makeRes();

    await controller.getDocs(req, res);

    expect(pgSync.getDocs.args[0][1]).to.equal(0);
  });

  it('rejects unauthenticated requests (no userCtx)', async () => {
    const notLoggedIn = sinon.stub(serverUtils, 'notLoggedIn');
    const getDocs = sinon.stub(pgSync, 'getDocs');
    const req = { body: { since: 0 } };
    const res = makeRes();

    await controller.getDocs(req, res);

    expect(notLoggedIn.callCount).to.equal(1);
    expect(notLoggedIn.args[0][0]).to.equal(req);
    expect(notLoggedIn.args[0][1]).to.equal(res);
    expect(getDocs.callCount).to.equal(0);
  });

  it('rejects unauthenticated requests (userCtx without name)', async () => {
    const notLoggedIn = sinon.stub(serverUtils, 'notLoggedIn');
    const getDocs = sinon.stub(pgSync, 'getDocs');
    const req = { userCtx: {}, body: { since: 0 } };
    const res = makeRes();

    await controller.getDocs(req, res);

    expect(notLoggedIn.callCount).to.equal(1);
    expect(getDocs.callCount).to.equal(0);
  });

  it('routes service errors to serverUtils.serverError', async () => {
    sinon.stub(pgSync, 'getDocs').rejects(new Error('boom'));
    const serverError = sinon.stub(serverUtils, 'serverError');
    const req = { userCtx: { name: 'alice', contact_id: 'c1' }, body: { since: 0 } };
    const res = makeRes();

    await controller.getDocs(req, res);

    expect(serverError.callCount).to.equal(1);
    expect(serverError.args[0][0]).to.be.an('error');
    expect(serverError.args[0][1]).to.equal(req);
    expect(serverError.args[0][2]).to.equal(res);
  });
});
