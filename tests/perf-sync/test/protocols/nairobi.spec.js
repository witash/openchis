'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const nairobi = require('../../lib/protocols/nairobi');

describe('protocols/nairobi', () => {
  describe('buildRemoteAuthHeader', () => {
    it('formats Basic auth from username + password', () => {
      const h = nairobi.buildRemoteAuthHeader({ username: 'medic', password: 'pwd' });
      expect(h).to.equal('Basic ' + Buffer.from('medic:pwd').toString('base64'));
    });
  });

  describe('makeRemote', () => {
    it('constructs a PouchDB instance against <baseUrl>/medic with Basic auth options', () => {
      const PouchDBStub = sinon.spy(function PouchDB() {});
      const user = { username: 'u', password: 'p' };
      nairobi.makeRemote(PouchDBStub, 'http://server', user);
      expect(PouchDBStub.calledWithNew()).to.equal(true);
      expect(PouchDBStub.firstCall.args[0]).to.equal('http://server/medic');
      const opts = PouchDBStub.firstCall.args[1];
      expect(opts.skip_setup).to.equal(true);
      expect(opts.auth).to.deep.equal({ username: 'u', password: 'p' });
    });
  });

  describe('sync', () => {
    it('calls the supplied replicateFn with the remote/local pair and a batch_size', async () => {
      const result = { docs_written: 42, last_seq: 'abc' };
      const replicateFn = sinon.stub().resolves(result);
      const remote = { _kind: 'remote' };
      const local = { _kind: 'local' };

      const out = await nairobi.sync({ remote, local, replicateFn });

      expect(replicateFn.calledOnce).to.equal(true);
      expect(replicateFn.firstCall.args[0]).to.equal(remote);
      expect(replicateFn.firstCall.args[1]).to.equal(local);
      expect(replicateFn.firstCall.args[2]).to.have.property('batch_size');
      expect(out.docs_pulled).to.equal(42);
      expect(out.docs_pushed).to.equal(0);
      expect(out.last_seq).to.equal('abc');
      expect(out.elapsed_ms).to.be.a('number').and.at.least(0);
    });

    it('reports 0 docs_pulled when replicate returns no docs_written', async () => {
      const replicateFn = sinon.stub().resolves({});
      const out = await nairobi.sync({ remote: {}, local: {}, replicateFn });
      expect(out.docs_pulled).to.equal(0);
      expect(out.last_seq).to.equal(null);
    });

    it('propagates replicate errors', async () => {
      const replicateFn = sinon.stub().rejects(new Error('boom'));
      let err;
      try {
        await nairobi.sync({ remote: {}, local: {}, replicateFn });
      } catch (e) {
        err = e;
      }
      expect(err).to.be.an('error');
      expect(err.message).to.equal('boom');
    });

    it('passes a custom since to ongoing syncs', async () => {
      const replicateFn = sinon.stub().resolves({});
      await nairobi.sync({ remote: {}, local: {}, replicateFn, since: 'seq-99' });
      expect(replicateFn.firstCall.args[2].since).to.equal('seq-99');
    });
  });
});
