const { expect } = require('chai');
const sinon = require('sinon');

const controller = require('../../../src/controllers/pg-sync');
const pgSync = require('../../../src/services/pg-sync/pg-sync');
const postgresSync = require('@medic/postgres-sync');
const pgPool = require('../../../src/services/postgres-sync');
const serverUtils = require('../../../src/server-utils');

const makeRes = () => ({
  json: sinon.stub(),
  status: sinon.stub().returnsThis(),
});

const makeClient = () => ({
  query: sinon.stub().resolves({ rows: [] }),
  release: sinon.stub(),
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

  describe('writeDocs', () => {
    it('writes posted docs straight to postgres in a transaction', async () => {
      const client = makeClient();
      const pool = { connect: sinon.stub().resolves(client) };
      sinon.stub(pgPool, 'getPool').returns(pool);
      const transformAndWrite = sinon.stub(postgresSync, 'transformAndWrite').resolves();

      const req = {
        userCtx: { name: 'alice' },
        body: { docs: [{ _id: 'd1', _rev: '2-existing', type: 'person' }] },
      };
      const res = makeRes();

      await controller.writeDocs(req, res);

      // Wrapped in BEGIN/COMMIT, no ROLLBACK.
      const queries = client.query.getCalls().map(c => c.args[0]);
      expect(queries).to.deep.equal(['BEGIN', 'COMMIT']);
      expect(client.release.callCount).to.equal(1);

      // The doc (with its existing rev preserved) is handed to transformAndWrite.
      expect(transformAndWrite.callCount).to.equal(1);
      expect(transformAndWrite.firstCall.args[0]).to.deep.equal([
        { _id: 'd1', _rev: '2-existing', type: 'person' },
      ]);
      expect(transformAndWrite.firstCall.args[1]).to.equal(client);

      // CouchDB-style response.
      expect(res.json.args).to.deep.equal([[[{ ok: true, id: 'd1', rev: '2-existing' }]]]);
    });

    it('assigns a first-generation rev to docs that lack one', async () => {
      const client = makeClient();
      sinon.stub(pgPool, 'getPool').returns({ connect: sinon.stub().resolves(client) });
      const transformAndWrite = sinon.stub(postgresSync, 'transformAndWrite').resolves();

      const req = { userCtx: { name: 'alice' }, body: { docs: [{ _id: 'd1', type: 'clinic' }] } };
      const res = makeRes();

      await controller.writeDocs(req, res);

      const written = transformAndWrite.firstCall.args[0][0];
      expect(written._id).to.equal('d1');
      expect(written._rev).to.match(/^1-[0-9a-f]{32}$/);
      // The response echoes the same generated rev.
      expect(res.json.firstCall.args[0]).to.deep.equal([{ ok: true, id: 'd1', rev: written._rev }]);
    });

    it('stubs docs missing an _id without sending them to postgres', async () => {
      const client = makeClient();
      sinon.stub(pgPool, 'getPool').returns({ connect: sinon.stub().resolves(client) });
      const transformAndWrite = sinon.stub(postgresSync, 'transformAndWrite').resolves();

      const req = {
        userCtx: { name: 'alice' },
        body: { docs: [{ type: 'person' }, { _id: 'ok', type: 'person' }] },
      };
      const res = makeRes();

      await controller.writeDocs(req, res);

      expect(transformAndWrite.firstCall.args[0].map(d => d._id)).to.deep.equal(['ok']);
      const response = res.json.firstCall.args[0];
      expect(response[0]).to.deep.equal({ error: 'bad_request', reason: 'doc must include _id' });
      expect(response[1]).to.include({ ok: true, id: 'ok' });
    });

    it('does not touch postgres when no doc has an _id', async () => {
      const connect = sinon.stub();
      sinon.stub(pgPool, 'getPool').returns({ connect });
      const transformAndWrite = sinon.stub(postgresSync, 'transformAndWrite');

      const req = { userCtx: { name: 'alice' }, body: { docs: [{ type: 'person' }] } };
      const res = makeRes();

      await controller.writeDocs(req, res);

      expect(connect.callCount).to.equal(0);
      expect(transformAndWrite.callCount).to.equal(0);
      expect(res.json.firstCall.args[0]).to.deep.equal([
        { error: 'bad_request', reason: 'doc must include _id' },
      ]);
    });

    it('rolls back and reports a server error when the write fails', async () => {
      const client = makeClient();
      client.query.withArgs('BEGIN').resolves();
      sinon.stub(pgPool, 'getPool').returns({ connect: sinon.stub().resolves(client) });
      sinon.stub(postgresSync, 'transformAndWrite').rejects(new Error('disk full'));
      const serverError = sinon.stub(serverUtils, 'serverError');

      const req = { userCtx: { name: 'alice' }, body: { docs: [{ _id: 'd1', type: 'person' }] } };
      const res = makeRes();

      await controller.writeDocs(req, res);

      expect(client.query.calledWith('ROLLBACK')).to.equal(true);
      expect(client.query.calledWith('COMMIT')).to.equal(false);
      expect(client.release.callCount).to.equal(1);
      expect(serverError.callCount).to.equal(1);
      expect(serverError.args[0][0]).to.be.an('error');
    });

    it('returns 400 when the body has no docs array', async () => {
      const req = { userCtx: { name: 'alice' }, body: {} };
      const res = makeRes();

      await controller.writeDocs(req, res);

      expect(res.status.args).to.deep.equal([[400]]);
      expect(res.json.firstCall.args[0]).to.include({ error: 'bad_request' });
    });

    it('reports a server error when POSTGRES_URL is not configured (no pool)', async () => {
      sinon.stub(pgPool, 'getPool').returns(null);
      const serverError = sinon.stub(serverUtils, 'serverError');

      const req = { userCtx: { name: 'alice' }, body: { docs: [{ _id: 'd1' }] } };
      const res = makeRes();

      await controller.writeDocs(req, res);

      expect(serverError.callCount).to.equal(1);
      expect(serverError.args[0][0]).to.deep.include({ code: 503 });
    });

    it('rejects unauthenticated requests', async () => {
      const notLoggedIn = sinon.stub(serverUtils, 'notLoggedIn');
      const getPool = sinon.stub(pgPool, 'getPool');

      await controller.writeDocs({ body: { docs: [] } }, makeRes());

      expect(notLoggedIn.callCount).to.equal(1);
      expect(getPool.callCount).to.equal(0);
    });
  });
});
