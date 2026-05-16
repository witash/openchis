const { expect } = require('chai');
const sinon = require('sinon');

const pgPool = require('../../../src/services/postgres-sync');

describe('api postgres-sync pool helper', () => {
  const ORIGINAL_POSTGRES_URL = process.env.POSTGRES_URL;

  afterEach(() => {
    if (ORIGINAL_POSTGRES_URL === undefined) {
      delete process.env.POSTGRES_URL;
    } else {
      process.env.POSTGRES_URL = ORIGINAL_POSTGRES_URL;
    }
    pgPool._resetPool();
    sinon.restore();
  });

  it('returns null when POSTGRES_URL is not set (write-through disabled)', () => {
    delete process.env.POSTGRES_URL;
    const factory = sinon.stub();
    pgPool._setCreatePool(factory);
    expect(pgPool.getPool()).to.equal(null);
    expect(factory.callCount).to.equal(0);
  });

  it('calls the pool factory once with the connection string and caches the pool', () => {
    process.env.POSTGRES_URL = 'postgres://test/db';
    const fakePool = { end: sinon.stub().resolves() };
    const factory = sinon.stub().returns(fakePool);
    pgPool._setCreatePool(factory);

    const first = pgPool.getPool();
    const second = pgPool.getPool();

    expect(factory.callCount).to.equal(1);
    expect(factory.firstCall.args[0]).to.equal('postgres://test/db');
    expect(first).to.equal(fakePool);
    expect(second).to.equal(fakePool);
  });

  it('ends the pool and clears the cached reference on closePool', async () => {
    process.env.POSTGRES_URL = 'postgres://test/db';
    const fakePool = { end: sinon.stub().resolves() };
    pgPool._setCreatePool(() => fakePool);

    pgPool.getPool();
    await pgPool.closePool();
    expect(fakePool.end.callCount).to.equal(1);

    // Second close is a no-op.
    await pgPool.closePool();
    expect(fakePool.end.callCount).to.equal(1);
  });

  it('closePool is a no-op when no pool has been created', async () => {
    await pgPool.closePool();
  });
});
