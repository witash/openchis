const sinon = require('sinon');

const db = require('../../../../src/lib/postgres-sync/db');
const watcher = require('../../../../src/lib/postgres-sync/watcher');
const logger = require('@medic/logger');
const postgresSync = require('../../../../src/lib/postgres-sync');

describe('postgres-sync init', () => {
  const ORIGINAL_POSTGRES_URL = process.env.POSTGRES_URL;
  const realSetTimeout = setTimeout;
  const nextTick = () => new Promise((resolve) => realSetTimeout(resolve, 0));

  afterEach(() => {
    if (ORIGINAL_POSTGRES_URL === undefined) {
      delete process.env.POSTGRES_URL;
    } else {
      process.env.POSTGRES_URL = ORIGINAL_POSTGRES_URL;
    }
    sinon.restore();
  });

  it('does nothing when POSTGRES_URL is not set', () => {
    delete process.env.POSTGRES_URL;
    const info = sinon.stub(logger, 'info');
    const getPool = sinon.stub(db, 'getPool');

    postgresSync.init();

    expect(getPool.callCount).to.equal(0);
    expect(info.calledWithMatch(/disabled/)).to.equal(true);
  });

  it('starts the mirror without awaiting the runForever promise', async () => {
    process.env.POSTGRES_URL = 'postgres://test/db';
    const fakePool = {};
    sinon.stub(db, 'getPool').returns(fakePool);
    sinon.stub(db, 'getCouchUrl').returns('http://couch/medic');
    sinon.stub(db, 'ensureProgressTable').resolves();
    // Never resolves — the init call must not block on it.
    sinon.stub(watcher, 'runForever').returns(new Promise(() => {}));

    const result = postgresSync.init();

    // init is synchronous and returns undefined; the mirror runs in the
    // background. Wait one tick for the start() async chain to begin.
    expect(result).to.equal(undefined);
    await nextTick();

    expect(db.ensureProgressTable.callCount).to.equal(1);
    expect(db.ensureProgressTable.firstCall.args[0]).to.equal(fakePool);
    expect(watcher.runForever.callCount).to.equal(1);
    expect(watcher.runForever.firstCall.args[0]).to.deep.equal({
      pool: fakePool,
      couchUrl: 'http://couch/medic',
    });
  });

  it('logs and swallows fatal errors so sentinel does not crash', async () => {
    process.env.POSTGRES_URL = 'postgres://test/db';
    sinon.stub(db, 'getPool').returns({});
    sinon.stub(db, 'getCouchUrl').returns('http://couch/medic');
    sinon.stub(db, 'ensureProgressTable').rejects(new Error('pg down'));
    const error = sinon.stub(logger, 'error');

    postgresSync.init();
    await nextTick();
    await nextTick();

    expect(error.callCount).to.be.greaterThanOrEqual(1);
    const errArgs = error.firstCall.args;
    expect(errArgs[0]).to.match(/fatal/);
  });

  it('_start awaits ensureProgressTable then runForever in order', async () => {
    const fakePool = {};
    sinon.stub(db, 'getPool').returns(fakePool);
    sinon.stub(db, 'getCouchUrl').returns('http://couch/medic');
    const ensure = sinon.stub(db, 'ensureProgressTable').resolves();
    const forever = sinon.stub(watcher, 'runForever').resolves();

    await postgresSync._start();

    sinon.assert.callOrder(ensure, forever);
  });
});
