'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const PouchDB = require('pouchdb');
PouchDB.plugin(require('pouchdb-adapter-memory'));

const pgSync = require('../../lib/protocols/pg-sync');

// Build a fetch stub that returns the supplied (status, body) tuple as a
// Response-like object. We avoid the global fetch / Response classes so we
// can keep the spec deterministic and quick.
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

const makeLocal = (suffix) => new PouchDB(`pg-sync-spec-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}`, { adapter: 'memory' });

describe('protocols/pg-sync', () => {
  describe('partitionDocs', () => {
    it('splits docs by _deleted', () => {
      const docs = [
        { _id: 'a' },
        { _id: 'b', _deleted: true },
        { _id: 'c', _deleted: false },
        null,
      ];
      const { upserts, deletes } = pgSync.partitionDocs(docs);
      expect(upserts.map((d) => d._id)).to.deep.equal(['a', 'c']);
      expect(deletes.map((d) => d._id)).to.deep.equal(['b']);
    });

    it('returns empty arrays for empty / nullish input', () => {
      expect(pgSync.partitionDocs(undefined)).to.deep.equal({ upserts: [], deletes: [] });
      expect(pgSync.partitionDocs([])).to.deep.equal({ upserts: [], deletes: [] });
    });
  });

  describe('readSince / writeSince', () => {
    let local;
    beforeEach(() => { local = makeLocal('rw'); });
    afterEach(async () => { await local.destroy(); });

    it('returns 0 when the _local state doc is missing', async () => {
      expect(await pgSync.readSince(local)).to.equal(0);
    });

    it('round-trips the last_seq through the _local state doc', async () => {
      await pgSync.writeSince(local, 12345);
      expect(await pgSync.readSince(local)).to.equal(12345);
      await pgSync.writeSince(local, 67890);
      expect(await pgSync.readSince(local)).to.equal(67890);
    });
  });

  describe('sync', () => {
    let local;
    beforeEach(() => { local = makeLocal('sync'); });
    afterEach(async () => { await local.destroy(); });

    it('passes since=0 on initial sync and persists the new last_seq', async () => {
      // new_edits: false requires _rev on every doc; the real pg-sync endpoint
      // includes the full doc body (incl. _rev) for replicated mirror rows.
      const docs = [
        { _id: 'rep-1', _rev: '1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', type: 'data_record', form: 'pregnancy' },
        { _id: 'rep-2', _rev: '1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', type: 'data_record', form: 'pregnancy' },
      ];
      const fetchFn = sinon.stub().resolves(okJson({ docs, last_seq: 99 }));

      const out = await pgSync.sync({
        local,
        baseUrl: 'http://server',
        user: { username: 'u', password: 'p' },
        fetchFn,
      });

      expect(fetchFn.calledOnce).to.equal(true);
      const [url, init] = fetchFn.firstCall.args;
      expect(url).to.equal('http://server/api/v1/pg-sync');
      expect(init.method).to.equal('POST');
      expect(JSON.parse(init.body)).to.deep.equal({ since: 0 });

      expect(out.docs_pulled).to.equal(2);
      expect(out.last_seq).to.equal(99);
      expect(await pgSync.readSince(local)).to.equal(99);
      const stored = await local.get('rep-1');
      expect(stored._id).to.equal('rep-1');
    });

    it('uses the stored since on subsequent syncs', async () => {
      await pgSync.writeSince(local, 50);
      const fetchFn = sinon.stub().resolves(okJson({ docs: [], last_seq: 50 }));
      await pgSync.sync({ local, baseUrl: 'http://server', user: { username: 'u', password: 'p' }, fetchFn });
      const sent = JSON.parse(fetchFn.firstCall.args[1].body);
      expect(sent).to.deep.equal({ since: 50 });
    });

    it('routes tombstones into bulkDocs as deletes', async () => {
      const calls = [];
      const stubLocal = {
        get: local.get.bind(local),
        put: local.put.bind(local),
        bulkDocs: async (docs, opts) => {
          calls.push({ docs, opts });
          return docs.map((d) => ({ ok: true, id: d._id, rev: d._rev || '1-x' }));
        },
      };
      const fetchFn = sinon.stub().resolves(okJson({
        docs: [
          { _id: 'live', _rev: '1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', form: 'pregnancy' },
          { _id: 'doomed', _rev: '2-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', _deleted: true },
        ],
        last_seq: 7,
      }));

      await pgSync.sync({ local: stubLocal, baseUrl: 'http://server', user: { username: 'u', password: 'p' }, fetchFn });

      const allBulks = calls.flatMap((c) => c.docs);
      const liveCall = calls.find((c) => c.docs.some((d) => d._id === 'live'));
      const deleteCall = calls.find((c) => c.docs.some((d) => d._id === 'doomed'));
      expect(allBulks.map((d) => d._id)).to.have.members(['live', 'doomed']);
      expect(liveCall.opts).to.deep.equal({ new_edits: false });
      expect(deleteCall.opts).to.deep.equal({ new_edits: false });
      expect(deleteCall.docs[0]._deleted).to.equal(true);
      expect(await pgSync.readSince(local)).to.equal(7);
    });

    it('leaves _local state untouched on HTTP failure (a retry resends the same since)', async () => {
      await pgSync.writeSince(local, 17);
      const fetchFn = sinon.stub().resolves(fail(500, 'server error'));

      let err;
      try {
        await pgSync.sync({ local, baseUrl: 'http://server', user: { username: 'u', password: 'p' }, fetchFn });
      } catch (e) { err = e; }
      expect(err).to.be.an('error');
      expect(err.message).to.match(/status=500/);
      expect(await pgSync.readSince(local)).to.equal(17);
    });

    it('does not advance _local when bulkDocs throws mid-sync', async () => {
      await pgSync.writeSince(local, 3);
      const exploder = {
        get: local.get.bind(local),
        put: local.put.bind(local),
        bulkDocs: sinon.stub().rejects(new Error('bulkDocs blew up')),
      };
      const fetchFn = sinon.stub().resolves(okJson({ docs: [{ _id: 'x' }], last_seq: 99 }));

      let err;
      try {
        await pgSync.sync({ local: exploder, baseUrl: 'http://server', user: { username: 'u', password: 'p' }, fetchFn });
      } catch (e) { err = e; }
      expect(err).to.be.an('error');
      expect(err.message).to.match(/bulkDocs blew up/);
      // The state doc reads from `local`, which never advanced.
      expect(await pgSync.readSince(local)).to.equal(3);
    });

    it('sends Basic auth derived from the user credentials', async () => {
      const fetchFn = sinon.stub().resolves(okJson({ docs: [], last_seq: 0 }));
      await pgSync.sync({ local, baseUrl: 'http://x', user: { username: 'alice', password: 's3cret' }, fetchFn });
      const init = fetchFn.firstCall.args[1];
      const expected = 'Basic ' + Buffer.from('alice:s3cret').toString('base64');
      expect(init.headers.Authorization).to.equal(expected);
    });

    it('reports an http_ms / bulk_ms breakdown', async () => {
      const fetchFn = sinon.stub().resolves(okJson({
        docs: [{ _id: 'one', _rev: '1-cccccccccccccccccccccccccccccccc' }],
        last_seq: 1,
      }));
      const out = await pgSync.sync({ local, baseUrl: 'http://x', user: { username: 'u', password: 'p' }, fetchFn });
      expect(out.breakdown).to.have.property('http_ms');
      expect(out.breakdown).to.have.property('bulk_ms');
    });
  });
});
