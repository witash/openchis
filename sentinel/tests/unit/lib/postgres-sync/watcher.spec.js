const sinon = require('sinon');

const watcher = require('../../../../src/lib/postgres-sync/watcher');
const importer = require('../../../../src/lib/postgres-sync/importer');

describe('postgres-sync watcher', () => {
  afterEach(() => sinon.restore());

  describe('buildSource', () => {
    it('returns hostname + path for a url with a db path', () => {
      expect(watcher.buildSource('http://admin:secret@db.example.com/medic'))
        .to.equal('db.example.com/medic');
    });

    it('returns just hostname + / for a url without a path', () => {
      expect(watcher.buildSource('http://localhost:5984/'))
        .to.equal('localhost/');
    });
  });

  describe('fetchChanges', () => {
    it('GETs <couchUrl>/_changes with since/limit/include_docs/feed params', async () => {
      const httpGet = sinon.stub().resolves({ results: [], last_seq: 0 });
      watcher._setHttpGet(httpGet);

      const data = await watcher.fetchChanges('http://couch/medic', 5, 100);

      expect(httpGet.callCount).to.equal(1);
      expect(httpGet.firstCall.args[0]).to.equal('http://couch/medic/_changes');
      expect(httpGet.firstCall.args[1]).to.deep.equal({
        since: 5,
        limit: 100,
        include_docs: true,
        feed: 'normal',
      });
      expect(data).to.deep.equal({ results: [], last_seq: 0 });
    });
  });

  describe('runOnce', () => {
    let client;
    let pool;

    beforeEach(() => {
      client = { query: sinon.stub().resolves({ rows: [] }), release: sinon.stub() };
      pool = { connect: sinon.stub().resolves(client) };
    });

    it('reads progress, fetches changes, and processes the batch', async () => {
      sinon.stub(importer, 'getProgress').resolves('7-saved');
      const processBatch = sinon.stub(importer, 'processBatch').resolves({ processed: 2, last_seq: '9' });
      const httpGet = sinon.stub().resolves({ results: [{ id: 'x' }], last_seq: '9' });
      watcher._setHttpGet(httpGet);

      const result = await watcher.runOnce(
        { pool, couchUrl: 'http://couch/medic' },
        { batchSize: 50 }
      );

      expect(pool.connect.callCount).to.equal(1);
      expect(client.release.callCount).to.equal(1);
      expect(importer.getProgress.firstCall.args[1]).to.equal('couch/medic');
      expect(httpGet.firstCall.args[0]).to.equal('http://couch/medic/_changes');
      expect(httpGet.firstCall.args[1].since).to.equal('7-saved');
      expect(httpGet.firstCall.args[1].limit).to.equal(50);
      expect(processBatch.callCount).to.equal(1);
      expect(processBatch.firstCall.args).to.deep.equal([
        pool,
        'couch/medic',
        { results: [{ id: 'x' }], last_seq: '9' },
      ]);
      expect(result).to.deep.equal({ processed: 2, last_seq: '9' });
    });

    it('releases the bootstrap client even when getProgress fails', async () => {
      sinon.stub(importer, 'getProgress').rejects(new Error('progress down'));
      watcher._setHttpGet(sinon.stub());

      await expect(
        watcher.runOnce({ pool, couchUrl: 'http://couch/medic' })
      ).to.eventually.be.rejectedWith('progress down');
      expect(client.release.callCount).to.equal(1);
    });

    it('returns a no-op result when the changes payload is missing results', async () => {
      sinon.stub(importer, 'getProgress').resolves('3');
      const processBatch = sinon.stub(importer, 'processBatch');
      watcher._setHttpGet(sinon.stub().resolves(null));

      const result = await watcher.runOnce({ pool, couchUrl: 'http://couch/medic' });

      expect(processBatch.callCount).to.equal(0);
      expect(result).to.deep.equal({ processed: 0, last_seq: '3' });
    });

    it('uses the default batch size when none is given', async () => {
      sinon.stub(importer, 'getProgress').resolves(0);
      sinon.stub(importer, 'processBatch').resolves({ processed: 0, last_seq: 0 });
      const httpGet = sinon.stub().resolves({ results: [], last_seq: 0 });
      watcher._setHttpGet(httpGet);

      await watcher.runOnce({ pool, couchUrl: 'http://couch/medic' });

      expect(httpGet.firstCall.args[1].limit).to.equal(1000);
    });
  });

  describe('runForever', () => {
    it('loops, sleeps when the batch was empty, and stops on stop()', async () => {
      sinon.stub(importer, 'getProgress').resolves(0);
      const processBatch = sinon.stub(importer, 'processBatch');
      processBatch.onCall(0).resolves({ processed: 1, last_seq: 1 });
      processBatch.onCall(1).callsFake(() => {
        watcher.stop();
        return Promise.resolve({ processed: 0, last_seq: 1 });
      });
      watcher._setHttpGet(sinon.stub().resolves({ results: [{ id: 'a' }], last_seq: 1 }));

      const client = { query: sinon.stub().resolves({ rows: [] }), release: sinon.stub() };
      const pool = { connect: sinon.stub().resolves(client) };

      await watcher.runForever({ pool, couchUrl: 'http://couch/medic' }, { idleDelayMs: 1 });

      expect(processBatch.callCount).to.equal(2);
    });

    it('exits immediately when stop() is called before the first iteration', async () => {
      sinon.stub(importer, 'getProgress').resolves(0);
      const processBatch = sinon.stub(importer, 'processBatch')
        .callsFake(() => {
          watcher.stop();
          return Promise.resolve({ processed: 5, last_seq: 5 });
        });
      watcher._setHttpGet(sinon.stub().resolves({ results: [{ id: 'a' }], last_seq: 5 }));

      const client = { query: sinon.stub().resolves({ rows: [] }), release: sinon.stub() };
      const pool = { connect: sinon.stub().resolves(client) };

      await watcher.runForever({ pool, couchUrl: 'http://couch/medic' });
      expect(processBatch.callCount).to.equal(1);
    });
  });
});
