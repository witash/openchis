const { expect } = require('chai');
const sinon = require('sinon');

const pgSync = require('@medic/postgres-sync');
const pgPool = require('../../../src/services/postgres-sync');
const controller = require('../../../src/controllers/pg-sync-bulk-docs');

const makeClient = () => ({
  query: sinon.stub().resolves({ rows: [] }),
  release: sinon.stub(),
});

const makePool = (client) => ({
  connect: sinon.stub().resolves(client),
});

describe('pg-sync write-through (_bulk_docs interceptor)', () => {
  let client;
  let pool;

  beforeEach(() => {
    client = makeClient();
    pool = makePool(client);
    sinon.stub(pgPool, 'getPool').returns(pool);
  });

  afterEach(() => sinon.restore());

  describe('capture middleware', () => {
    it('snapshots the request docs and new_edits flag onto the response', () => {
      const docs = [{ _id: 'a', _rev: '1' }, { _id: 'b', _rev: '1' }];
      const req = { body: { docs, new_edits: false } };
      const res = {};
      const next = sinon.stub();

      controller.capture(req, res, next);

      expect(res.pgSyncOriginalDocs).to.equal(docs);
      expect(res.pgSyncNewEdits).to.equal(false);
      expect(res.pgSyncMirror).to.equal(controller.mirror);
      expect(next.callCount).to.equal(1);
    });

    it('defaults to an empty docs list when body or docs is missing', () => {
      const req1 = { body: {} };
      const res1 = {};
      controller.capture(req1, res1, () => {});
      expect(res1.pgSyncOriginalDocs).to.deep.equal([]);

      const req2 = {};
      const res2 = {};
      controller.capture(req2, res2, () => {});
      expect(res2.pgSyncOriginalDocs).to.deep.equal([]);
    });

    it('ignores non-array docs payloads', () => {
      const req = { body: { docs: 'oops' } };
      const res = {};
      controller.capture(req, res, () => {});
      expect(res.pgSyncOriginalDocs).to.deep.equal([]);
    });
  });

  describe('acceptedDocsFromResponse (new_edits=true)', () => {
    const fn = controller._acceptedDocsFromResponse;

    it('returns the accepted docs with CouchDB-assigned revs', () => {
      const docs = [
        { _id: 'a', _rev: '1-a', payload: 1 },
        { _id: 'b', _rev: '1-b', payload: 2 },
      ];
      const response = [
        { ok: true, id: 'a', rev: '2-aa' },
        { ok: true, id: 'b', rev: '2-bb' },
      ];
      expect(fn(docs, response, true)).to.deep.equal([
        { _id: 'a', _rev: '2-aa', payload: 1 },
        { _id: 'b', _rev: '2-bb', payload: 2 },
      ]);
    });

    it('drops error entries (per-doc rejections)', () => {
      const docs = [{ _id: 'a', _rev: '1' }, { _id: 'b', _rev: '1' }];
      const response = [
        { ok: true, id: 'a', rev: '2-aa' },
        { id: 'b', error: 'conflict', reason: 'Doc update conflict' },
      ];
      expect(fn(docs, response, true)).to.deep.equal([
        { _id: 'a', _rev: '2-aa' },
      ]);
    });

    it('drops `forbidden` stubs spliced in for offline users', () => {
      const docs = [
        { _id: 'a', _rev: '1' },
        { _id: 'b', _rev: '1' },
        { _id: 'c', _rev: '1' },
      ];
      const response = [
        { ok: true, id: 'a', rev: '2-aa' },
        { id: 'b', error: 'forbidden' },
        { ok: true, id: 'c', rev: '2-cc' },
      ];
      expect(fn(docs, response, true)).to.deep.equal([
        { _id: 'a', _rev: '2-aa' },
        { _id: 'c', _rev: '2-cc' },
      ]);
    });

    it('ignores response entries whose id is not in the original docs', () => {
      const docs = [{ _id: 'a', _rev: '1' }];
      const response = [
        { ok: true, id: 'a', rev: '2' },
        { ok: true, id: 'mystery', rev: '2' },
      ];
      expect(fn(docs, response, true)).to.have.length(1);
    });

    it('returns [] for empty / non-array inputs', () => {
      expect(fn([], [{ ok: true, id: 'a' }], true)).to.deep.equal([]);
      expect(fn([{ _id: 'a' }], null, true)).to.deep.equal([]);
      expect(fn(null, [], true)).to.deep.equal([]);
    });
  });

  describe('acceptedDocsFromResponse (new_edits=false)', () => {
    const fn = controller._acceptedDocsFromResponse;

    it('returns all docs when the response is an empty error array', () => {
      const docs = [
        { _id: 'a', _rev: '1-a' },
        { _id: 'b', _rev: '1-b' },
      ];
      // All accepted: docs keep their source _rev because new_edits=false.
      expect(fn(docs, [], false)).to.deep.equal(docs);
    });

    it('drops the docs whose ids appear in the per-doc error array', () => {
      const docs = [
        { _id: 'a', _rev: '1-a' },
        { _id: 'b', _rev: '1-b' },
        { _id: 'c', _rev: '1-c' },
      ];
      const response = [{ id: 'b', error: 'conflict', reason: 'no' }];
      expect(fn(docs, response, false)).to.deep.equal([
        { _id: 'a', _rev: '1-a' },
        { _id: 'c', _rev: '1-c' },
      ]);
    });

    it('drops docs lacking an _id (replication uploads must carry _id)', () => {
      const docs = [{ _id: 'a', _rev: '1' }, { _rev: '1' }];
      expect(fn(docs, [], false)).to.deep.equal([{ _id: 'a', _rev: '1' }]);
    });
  });

  describe('mirror — happy path', () => {
    it('calls transformAndWrite with only the accepted docs', async () => {
      const docs = [
        { _id: 'a', _rev: '1', type: 'data_record', form: 'p' },
        { _id: 'b', _rev: '1', type: 'data_record', form: 'p' },
      ];
      const res = {
        pgSyncOriginalDocs: docs,
        pgSyncNewEdits: undefined,
      };
      const req = {};
      const body = [
        { ok: true, id: 'a', rev: '2-aa' },
        { id: 'b', error: 'conflict' },
      ];
      const taw = sinon.stub(pgSync, 'transformAndWrite').resolves();

      const result = await controller.mirror(req, res, body);

      expect(taw.callCount).to.equal(1);
      const accepted = taw.firstCall.args[0];
      expect(accepted).to.have.length(1);
      expect(accepted[0]).to.deep.equal({ _id: 'a', _rev: '2-aa', type: 'data_record', form: 'p' });
      // BEGIN + COMMIT wrap the transformAndWrite.
      const queries = client.query.getCalls().map(c => c.args[0]);
      expect(queries).to.include('BEGIN');
      expect(queries).to.include('COMMIT');
      expect(client.release.callCount).to.equal(1);
      expect(result).to.deep.equal({ mirrored: 1 });
    });

    it('is a no-op (no pool connect) when there are no captured docs', async () => {
      const res = { pgSyncOriginalDocs: [], pgSyncNewEdits: false };
      const taw = sinon.stub(pgSync, 'transformAndWrite').resolves();

      const result = await controller.mirror({}, res, [{ ok: true, id: 'a' }]);

      expect(pool.connect.callCount).to.equal(0);
      expect(taw.callCount).to.equal(0);
      expect(result).to.deep.equal({ mirrored: 0 });
    });

    it('is a no-op when the response yields no accepted docs', async () => {
      const res = {
        pgSyncOriginalDocs: [{ _id: 'a', _rev: '1' }],
        pgSyncNewEdits: undefined,
      };
      const taw = sinon.stub(pgSync, 'transformAndWrite').resolves();

      const result = await controller.mirror({}, res, [{ id: 'a', error: 'conflict' }]);

      expect(pool.connect.callCount).to.equal(0);
      expect(taw.callCount).to.equal(0);
      expect(result).to.deep.equal({ mirrored: 0 });
    });

    it('skips entirely when POSTGRES_URL is not configured (pool is null)', async () => {
      pgPool.getPool.returns(null);
      const res = {
        pgSyncOriginalDocs: [{ _id: 'a', _rev: '1', type: 'data_record', form: 'p' }],
        pgSyncNewEdits: undefined,
      };
      const taw = sinon.stub(pgSync, 'transformAndWrite').resolves();

      const result = await controller.mirror({}, res, [{ ok: true, id: 'a', rev: '2-aa' }]);

      expect(taw.callCount).to.equal(0);
      expect(result.mirrored).to.equal(0);
      expect(result.skipped).to.equal('no-postgres-url');
    });

    it('mirrors a replication upload (new_edits=false) using the source _rev', async () => {
      const docs = [
        { _id: 'a', _rev: '5-src', type: 'data_record', form: 'p' },
        { _id: 'b', _rev: '6-src', type: 'data_record', form: 'p' },
      ];
      const res = {
        pgSyncOriginalDocs: docs,
        pgSyncNewEdits: false,
      };
      const taw = sinon.stub(pgSync, 'transformAndWrite').resolves();

      await controller.mirror({}, res, []); // empty error array == all accepted

      const accepted = taw.firstCall.args[0];
      expect(accepted).to.deep.equal(docs);
    });
  });

  describe('mirror — error propagation', () => {
    it('rolls back and rethrows when transformAndWrite fails', async () => {
      const res = {
        pgSyncOriginalDocs: [{ _id: 'a', _rev: '1', type: 'data_record', form: 'p' }],
        pgSyncNewEdits: undefined,
      };
      sinon.stub(pgSync, 'transformAndWrite').rejects(new Error('pg down'));

      let caught;
      try {
        await controller.mirror({}, res, [{ ok: true, id: 'a', rev: '2' }]);
      } catch (e) {
        caught = e;
      }
      expect(caught).to.be.instanceOf(Error);
      expect(caught.message).to.equal('pg down');

      const queries = client.query.getCalls().map(c => c.args[0]);
      expect(queries).to.include('BEGIN');
      expect(queries).to.include('ROLLBACK');
      expect(queries).to.not.include('COMMIT');
      expect(client.release.callCount).to.equal(1);
    });

    it('still releases the client when ROLLBACK itself fails', async () => {
      const res = {
        pgSyncOriginalDocs: [{ _id: 'a', _rev: '1', type: 'data_record', form: 'p' }],
        pgSyncNewEdits: undefined,
      };
      sinon.stub(pgSync, 'transformAndWrite').rejects(new Error('pg down'));
      client.query.withArgs('ROLLBACK').rejects(new Error('disconnected'));

      let caught;
      try {
        await controller.mirror({}, res, [{ ok: true, id: 'a', rev: '2' }]);
      } catch (e) {
        caught = e;
      }
      expect(caught.message).to.equal('pg down');
      expect(client.release.callCount).to.equal(1);
    });
  });
});
