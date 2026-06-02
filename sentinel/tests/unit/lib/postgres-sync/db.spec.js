const sinon = require('sinon');

const db = require('../../../../src/lib/postgres-sync/db');

describe('postgres-sync db', () => {
  const ORIGINAL_POSTGRES_URL = process.env.POSTGRES_URL;

  afterEach(() => {
    if (ORIGINAL_POSTGRES_URL === undefined) {
      delete process.env.POSTGRES_URL;
    } else {
      process.env.POSTGRES_URL = ORIGINAL_POSTGRES_URL;
    }
    db._resetPool();
    sinon.restore();
  });

  describe('getCouchUrl', () => {
    it('returns a couch url from @medic/environment', () => {
      const url = db.getCouchUrl();
      expect(typeof url).to.equal('string');
      expect(url).to.match(/^https?:\/\//);
    });
  });

  describe('getPostgresUrl', () => {
    it('returns the value of POSTGRES_URL', () => {
      process.env.POSTGRES_URL = 'postgres://test/db';
      expect(db.getPostgresUrl()).to.equal('postgres://test/db');
    });

    it('throws when POSTGRES_URL is not set', () => {
      delete process.env.POSTGRES_URL;
      expect(() => db.getPostgresUrl()).to.throw('POSTGRES_URL');
    });
  });

  describe('getPool', () => {
    it('calls the pool factory once with the configured connection string and caches', () => {
      process.env.POSTGRES_URL = 'postgres://test/db';
      const fakePool = { end: sinon.stub().resolves() };
      const factory = sinon.stub().returns(fakePool);
      db._setCreatePool(factory);

      const first = db.getPool();
      const second = db.getPool();

      expect(factory.callCount).to.equal(1);
      expect(factory.firstCall.args[0]).to.equal('postgres://test/db');
      expect(first).to.equal(fakePool);
      expect(second).to.equal(fakePool);
    });
  });

  describe('closePool', () => {
    it('ends the pool and clears the cached reference', async () => {
      process.env.POSTGRES_URL = 'postgres://test/db';
      const fakePool = { end: sinon.stub().resolves() };
      db._setCreatePool(() => fakePool);

      db.getPool();
      await db.closePool();
      expect(fakePool.end.callCount).to.equal(1);

      // Second close is a no-op (pool was cleared).
      await db.closePool();
      expect(fakePool.end.callCount).to.equal(1);
    });

    it('is a no-op when no pool has been created', async () => {
      await db.closePool();
    });
  });

  describe('ensureProgressTable', () => {
    it('issues the CREATE TABLE IF NOT EXISTS statement and releases the client', async () => {
      const client = { query: sinon.stub().resolves(), release: sinon.stub() };
      const pool = { connect: sinon.stub().resolves(client) };

      await db.ensureProgressTable(pool);

      expect(pool.connect.callCount).to.equal(1);
      expect(client.query.callCount).to.equal(1);
      expect(client.query.firstCall.args[0]).to.match(/CREATE TABLE IF NOT EXISTS couch2pg_progress/);
      expect(client.release.callCount).to.equal(1);
    });

    it('releases the client even when the query fails', async () => {
      const client = { query: sinon.stub().rejects(new Error('nope')), release: sinon.stub() };
      const pool = { connect: sinon.stub().resolves(client) };

      await expect(db.ensureProgressTable(pool)).to.eventually.be.rejectedWith('nope');
      expect(client.release.callCount).to.equal(1);
    });
  });
});
