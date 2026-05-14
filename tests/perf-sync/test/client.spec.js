'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const PouchDB = require('pouchdb');
PouchDB.plugin(require('pouchdb-adapter-memory'));

const client = require('../lib/client');

const okJson = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

describe('client', () => {
  describe('runClient (nairobi protocol)', () => {
    it('runs each requested sync, emits per-sync metric IPC messages, then a done message', async () => {
      const replicateFn = sinon.stub().resolves({ docs_written: 17, last_seq: 'abc' });
      const sendMessage = sinon.spy();
      const spec = {
        id: 'u1',
        username: 'user1',
        password: 'pwd',
        scenario: 'baseline',
        protocol: 'nairobi',
        syncs: [{ kind: 'initial' }, { kind: 'ongoing', since: 'abc' }],
      };

      await client.runClient({
        PouchDB,
        fetchFn: () => { throw new Error('fetch should not be called for nairobi'); },
        replicateFn,
        sendMessage,
        spec,
        baseUrl: 'http://server',
      });

      expect(replicateFn.calledTwice).to.equal(true);
      const metrics = sendMessage.getCalls().filter((c) => c.args[0].type === 'metric').map((c) => c.args[0].row);
      expect(metrics).to.have.length(2);
      expect(metrics[0]).to.include({
        scenario: 'baseline', protocol: 'nairobi', user_id: 'u1', sync_index: 0, kind: 'initial', docs_pulled: 17,
      });
      expect(metrics[1]).to.include({ sync_index: 1, kind: 'ongoing' });

      const last = sendMessage.lastCall.args[0];
      expect(last).to.deep.equal({ type: 'done', user_id: 'u1' });
    });

    it('emits a metric row with `error` set when a sync rejects', async () => {
      const replicateFn = sinon.stub().rejects(new Error('connection refused'));
      const sendMessage = sinon.spy();
      const spec = {
        id: 'u-err',
        username: 'u',
        password: 'p',
        scenario: 'baseline',
        protocol: 'nairobi',
        syncs: [{ kind: 'initial' }],
      };

      await client.runClient({
        PouchDB,
        fetchFn: () => { throw new Error('unused'); },
        replicateFn,
        sendMessage,
        spec,
        baseUrl: 'http://server',
      });

      const metric = sendMessage.getCalls().find((c) => c.args[0].type === 'metric').args[0].row;
      expect(metric.error).to.equal('connection refused');
      expect(metric.docs_pulled).to.equal(0);
    });
  });

  describe('runClient (pg-sync protocol)', () => {
    it('drives pg-sync via fetch and reports the doc counts on the metric row', async () => {
      const fetchFn = sinon.stub();
      fetchFn.onFirstCall().resolves(okJson({
        docs: [
          { _id: 'a', _rev: '1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
          { _id: 'b', _rev: '1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
        ],
        last_seq: 22,
      }));
      const sendMessage = sinon.spy();
      const spec = {
        id: 'u-pg',
        username: 'u',
        password: 'p',
        scenario: 'baseline',
        protocol: 'pg-sync',
        syncs: [{ kind: 'initial' }],
      };

      await client.runClient({
        PouchDB,
        fetchFn,
        replicateFn: () => { throw new Error('replicate should not be called for pg-sync'); },
        sendMessage,
        spec,
        baseUrl: 'http://server',
      });

      expect(fetchFn.calledOnce).to.equal(true);
      const url = fetchFn.firstCall.args[0];
      expect(url).to.equal('http://server/api/v1/pg-sync');
      const metric = sendMessage.getCalls().find((c) => c.args[0].type === 'metric').args[0].row;
      expect(metric.docs_pulled).to.equal(2);
      expect(metric.error).to.equal('');
    });
  });

  describe('runSync', () => {
    it('rejects on an unknown protocol', async () => {
      let err;
      try {
        await client.runSync({ protocol: 'gopher' });
      } catch (e) { err = e; }
      expect(err).to.be.an('error');
      expect(err.message).to.match(/unknown protocol/);
    });
  });
});
