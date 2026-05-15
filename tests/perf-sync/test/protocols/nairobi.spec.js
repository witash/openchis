'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const nairobi = require('../../lib/protocols/nairobi');

const okJson = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
});
const fail = (status, body) => ({
  ok: false,
  status,
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

describe('protocols/nairobi', () => {
  describe('buildAuthHeader', () => {
    it('formats Basic auth from username + password', () => {
      const h = nairobi.buildAuthHeader({ username: 'medic', password: 'pwd' });
      expect(h).to.equal('Basic ' + Buffer.from('medic:pwd').toString('base64'));
    });
  });

  describe('makeRemote', () => {
    it('constructs a PouchDB instance against <baseUrl>/medic with an auth-injecting fetch', () => {
      const PouchDBStub = sinon.spy(function PouchDB() {});
      nairobi.makeRemote(PouchDBStub, 'http://server', { username: 'u', password: 'p' });
      expect(PouchDBStub.calledWithNew()).to.equal(true);
      expect(PouchDBStub.firstCall.args[0]).to.equal('http://server/medic');
      const opts = PouchDBStub.firstCall.args[1];
      expect(opts.skip_setup).to.equal(true);
      expect(opts.fetch).to.be.a('function');
    });
  });

  describe('buildAuthFetch', () => {
    it('preserves headers when the source is a Headers instance (the path PouchDB takes)', async () => {
      // pouchdb-adapter-http passes opts.headers as a node-fetch Headers
      // instance whose entries are reachable only via forEach /
      // Symbol.iterator (data lives in a Symbol-keyed internal slot).
      // A naive Object.assign would drop everything, and undici's
      // Request constructor would then reject the init. Build the auth
      // fetch and assert the underlying fetch receives a Headers
      // instance carrying both the original entries and our Authorization.
      const calls = [];
      const fakeFetch = (url, init) => {
        calls.push({ url, init });
        return Promise.resolve({ ok: true });
      };
      const wrapped = nairobi.buildAuthFetch({ username: 'u', password: 'p' }, fakeFetch);
      const incoming = new globalThis.Headers();
      incoming.set('Content-Type', 'application/json');
      incoming.set('Accept', 'application/json');
      await wrapped('http://server/medic/_bulk_docs', { method: 'POST', headers: incoming, body: '{}' });
      expect(calls).to.have.length(1);
      const { init } = calls[0];
      expect(init.headers).to.be.instanceOf(globalThis.Headers);
      expect(init.headers.get('Content-Type')).to.equal('application/json');
      expect(init.headers.get('Accept')).to.equal('application/json');
      expect(init.headers.get('Authorization')).to.equal('Basic ' + Buffer.from('u:p').toString('base64'));
      // Body / method are forwarded unchanged.
      expect(init.method).to.equal('POST');
      expect(init.body).to.equal('{}');
    });

    it('still works when the source is a plain-object headers map', async () => {
      const calls = [];
      const wrapped = nairobi.buildAuthFetch(
        { username: 'u', password: 'p' },
        (url, init) => { calls.push({ url, init }); return Promise.resolve({ ok: true }); },
      );
      await wrapped('http://server', { headers: { Accept: 'application/json' } });
      expect(calls[0].init.headers.get('Accept')).to.equal('application/json');
      expect(calls[0].init.headers.get('Authorization')).to.equal('Basic ' + Buffer.from('u:p').toString('base64'));
    });
  });

  describe('fetchIds', () => {
    it('GETs /api/v1/replication/get-ids with Basic auth', async () => {
      const fetchFn = sinon.stub().resolves(okJson({ doc_ids_revs: [], last_seq: 5 }));
      const out = await nairobi.fetchIds({
        fetchFn,
        baseUrl: 'http://server',
        user: { username: 'u', password: 'p' },
      });
      expect(fetchFn.calledOnce).to.equal(true);
      expect(fetchFn.firstCall.args[0]).to.equal('http://server/api/v1/replication/get-ids');
      expect(fetchFn.firstCall.args[1].headers.Authorization).to.equal('Basic ' + Buffer.from('u:p').toString('base64'));
      expect(out.last_seq).to.equal(5);
    });

    it('throws on a non-ok response', async () => {
      const fetchFn = sinon.stub().resolves(fail(401, 'unauthorized'));
      let err;
      try {
        await nairobi.fetchIds({ fetchFn, baseUrl: 'http://server', user: { username: 'u', password: 'p' } });
      } catch (e) { err = e; }
      expect(err.message).to.match(/get-ids failed status=401/);
    });
  });

  describe('filterMissing', () => {
    it('keeps only id/rev pairs not already present locally with the same rev', async () => {
      const local = {
        allDocs: async () => ({
          rows: [
            { id: 'a', value: { rev: '1-aa' } },
            { id: 'b', value: { rev: '1-bb' } },
          ],
        }),
      };
      const out = await nairobi.filterMissing(local, [
        { id: 'a', rev: '1-aa' },        // already current → drop
        { id: 'b', rev: '2-bbnew' },     // newer rev remote → keep
        { id: 'c', rev: '1-cc' },        // missing locally → keep
      ]);
      expect(out).to.deep.equal([
        { id: 'b', rev: '2-bbnew' },
        { id: 'c', rev: '1-cc' },
      ]);
    });
  });

  describe('fetchBatchDocs', () => {
    it('POSTs to /medic/_bulk_get with the batch payload and unwraps results[].docs[0].ok', async () => {
      const fetchFn = sinon.stub().resolves(okJson({
        results: [
          { id: 'a', docs: [{ ok: { _id: 'a', _rev: '1-aa' } }] },
          { id: 'b', docs: [{ ok: { _id: 'b', _rev: '1-bb' } }] },
          { id: 'c', docs: [{ error: { error: 'not_found' } }] },
        ],
      }));
      const out = await nairobi.fetchBatchDocs({
        fetchFn,
        baseUrl: 'http://server',
        user: { username: 'u', password: 'p' },
        batch: [{ id: 'a', rev: '1-aa' }, { id: 'b', rev: '1-bb' }, { id: 'c', rev: '1-cc' }],
      });
      expect(fetchFn.firstCall.args[0]).to.equal('http://server/medic/_bulk_get?revs=true&attachments=true');
      expect(fetchFn.firstCall.args[1].method).to.equal('POST');
      expect(JSON.parse(fetchFn.firstCall.args[1].body).docs).to.have.length(3);
      expect(out.map((d) => d._id)).to.deep.equal(['a', 'b']);
    });

    it('throws on a non-ok response', async () => {
      const fetchFn = sinon.stub().resolves(fail(500, 'boom'));
      let err;
      try {
        await nairobi.fetchBatchDocs({
          fetchFn, baseUrl: 'http://server', user: { username: 'u', password: 'p' }, batch: [{ id: 'a', rev: 'x' }],
        });
      } catch (e) { err = e; }
      expect(err.message).to.match(/_bulk_get failed status=500/);
    });
  });

  describe('initialSync', () => {
    it('walks get-ids -> filter -> bulkGet -> local.bulkDocs in batches', async () => {
      // 250 doc ids, batch size 100 → 3 bulk-get requests
      const idsRevs = [];
      for (let i = 0; i < 250; i++) {
        idsRevs.push({ id: `d${i}`, rev: `1-${i}` });
      }
      const fetchFn = sinon.stub();
      fetchFn.onCall(0).resolves(okJson({ doc_ids_revs: idsRevs, last_seq: 999 }));
      // The three _bulk_get calls each respond with simple docs.
      const buildBulkResp = (slice) => okJson({
        results: slice.map(({ id, rev }) => ({ id, docs: [{ ok: { _id: id, _rev: rev } }] })),
      });
      fetchFn.onCall(1).callsFake(() => Promise.resolve(buildBulkResp(idsRevs.slice(0, 100))));
      fetchFn.onCall(2).callsFake(() => Promise.resolve(buildBulkResp(idsRevs.slice(100, 200))));
      fetchFn.onCall(3).callsFake(() => Promise.resolve(buildBulkResp(idsRevs.slice(200, 250))));
      const bulkDocs = sinon.stub().resolves([]);
      const local = {
        allDocs: async () => ({ rows: [] }),
        bulkDocs,
      };

      const out = await nairobi.initialSync({
        local,
        baseUrl: 'http://server',
        user: { username: 'u', password: 'p' },
        fetchFn,
      });

      expect(fetchFn.callCount).to.equal(4); // get-ids + 3 bulk-get
      expect(bulkDocs.callCount).to.equal(3);
      const writtenIds = bulkDocs.getCalls().flatMap((c) => c.args[0].map((d) => d._id));
      expect(writtenIds).to.have.length(250);
      expect(out.docs_pulled).to.equal(250);
      expect(out.last_seq).to.equal(999);
    });

    it('throws when the API responds with use_pg_sync', async () => {
      const fetchFn = sinon.stub().resolves(okJson({ use_pg_sync: true }));
      let err;
      try {
        await nairobi.initialSync({
          local: { allDocs: async () => ({ rows: [] }), bulkDocs: async () => [] },
          baseUrl: 'http://s', user: { username: 'u', password: 'p' }, fetchFn,
        });
      } catch (e) { err = e; }
      expect(err.message).to.match(/use_pg_sync/);
    });

    it('skips bulkDocs when no docs are missing', async () => {
      const fetchFn = sinon.stub().resolves(okJson({
        doc_ids_revs: [{ id: 'a', rev: '1-aa' }],
        last_seq: 5,
      }));
      const bulkDocs = sinon.spy();
      const out = await nairobi.initialSync({
        local: {
          allDocs: async () => ({ rows: [{ id: 'a', value: { rev: '1-aa' } }] }),
          bulkDocs,
        },
        baseUrl: 'http://server', user: { username: 'u', password: 'p' }, fetchFn,
      });
      expect(fetchFn.callCount).to.equal(1); // only get-ids
      expect(bulkDocs.called).to.equal(false);
      expect(out.docs_pulled).to.equal(0);
    });
  });

  describe('ongoingSync', () => {
    it('calls replicateFn with since + batch_size', async () => {
      const replicateFn = sinon.stub().resolves({ docs_written: 7, last_seq: 'seq-2' });
      const out = await nairobi.ongoingSync({
        remote: {}, local: {}, replicateFn, since: 'seq-1',
      });
      expect(replicateFn.firstCall.args[2].since).to.equal('seq-1');
      expect(replicateFn.firstCall.args[2]).to.have.property('batch_size');
      expect(out.docs_pulled).to.equal(7);
      expect(out.last_seq).to.equal('seq-2');
    });
  });

  describe('sync', () => {
    it('dispatches to initialSync when no since is provided', async () => {
      const fetchFn = sinon.stub().resolves(okJson({ doc_ids_revs: [], last_seq: 1 }));
      const replicateFn = sinon.stub();
      const out = await nairobi.sync({
        remote: {},
        local: { allDocs: async () => ({ rows: [] }), bulkDocs: async () => [] },
        replicateFn,
        baseUrl: 'http://server',
        user: { username: 'u', password: 'p' },
        fetchFn,
      });
      expect(replicateFn.called).to.equal(false);
      expect(fetchFn.calledOnce).to.equal(true);
      expect(out.docs_pulled).to.equal(0);
      expect(out.elapsed_ms).to.be.a('number').and.at.least(0);
    });

    it('dispatches to ongoingSync when a since is provided', async () => {
      const replicateFn = sinon.stub().resolves({ docs_written: 4, last_seq: 'seq-5' });
      const out = await nairobi.sync({
        remote: {},
        local: {},
        replicateFn,
        baseUrl: 'http://server',
        user: { username: 'u', password: 'p' },
        fetchFn: () => { throw new Error('should not fetch during ongoing'); },
        since: 'seq-4',
      });
      expect(replicateFn.calledOnce).to.equal(true);
      expect(replicateFn.firstCall.args[2].since).to.equal('seq-4');
      expect(out.docs_pulled).to.equal(4);
    });
  });
});
