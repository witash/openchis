'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const { UserManager, buildUserPayload, buildAuth } = require('../lib/user-manager');

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

describe('user-manager', () => {
  describe('buildAuth', () => {
    it('formats admin credentials as Basic auth', () => {
      expect(buildAuth({ username: 'medic', password: 'pwd' })).to.equal(
        'Basic ' + Buffer.from('medic:pwd').toString('base64')
      );
    });
  });

  describe('buildUserPayload', () => {
    it('flattens the spec + hierarchy into the /api/v1/users payload shape', () => {
      const hierarchy = {
        healthCenter: { _id: 'hc1', type: 'health_center', name: 'HC', parent: { _id: 'dh1' } },
        userContact: { _id: 'p1', type: 'person', name: 'User', phone: '+1555' },
      };
      const spec = { username: 'u1', password: 'Pwd-1!!', roles: ['chw'], type: 'person' };
      const payload = buildUserPayload({ spec, hierarchy });
      expect(payload.username).to.equal('u1');
      expect(payload.password).to.equal('Pwd-1!!');
      expect(payload.roles).to.deep.equal(['chw']);
      expect(payload.place._id).to.equal('hc1');
      expect(payload.contact._id).to.equal('p1');
    });
  });

  describe('UserManager.createUser', () => {
    it('POSTs to /api/v1/users with admin Basic auth and parses the JSON response', async () => {
      const fetchFn = sinon.stub().resolves(okJson({ user: { id: 'org.couchdb.user:u1' } }));
      const mgr = new UserManager({ baseUrl: 'http://server', admin: { username: 'medic', password: 'pwd' }, fetchFn });
      const out = await mgr.createUser({
        spec: { username: 'u1', password: 'P1', roles: ['chw'] },
        hierarchy: {
          healthCenter: { _id: 'hc1', type: 'health_center', name: 'HC', parent: { _id: 'd' } },
          userContact: { _id: 'p1', type: 'person', name: 'U', phone: '+1' },
        },
      });
      expect(fetchFn.calledOnce).to.equal(true);
      const [url, init] = fetchFn.firstCall.args;
      expect(url).to.equal('http://server/api/v1/users');
      expect(init.method).to.equal('POST');
      expect(init.headers.Authorization).to.equal('Basic ' + Buffer.from('medic:pwd').toString('base64'));
      const body = JSON.parse(init.body);
      expect(body.username).to.equal('u1');
      expect(out.user.id).to.equal('org.couchdb.user:u1');
    });

    it('throws when the API rejects the request', async () => {
      const fetchFn = sinon.stub().resolves(fail(409, 'username exists'));
      const mgr = new UserManager({ baseUrl: 'http://server', admin: { username: 'm', password: 'p' }, fetchFn });
      let err;
      try {
        await mgr.createUser({
          spec: { username: 'u1', password: 'P1', roles: ['chw'] },
          hierarchy: {
            healthCenter: { _id: 'hc1', type: 'health_center', name: 'HC', parent: {} },
            userContact: { _id: 'p1', type: 'person', name: 'U', phone: '+1' },
          },
        });
      } catch (e) { err = e; }
      expect(err).to.be.an('error');
      expect(err.message).to.match(/status=409/);
    });
  });

  describe('UserManager.deleteUser', () => {
    it('issues DELETE /api/v1/users/<name>', async () => {
      const fetchFn = sinon.stub().resolves(okJson({}));
      const mgr = new UserManager({ baseUrl: 'http://server', admin: { username: 'm', password: 'p' }, fetchFn });
      const out = await mgr.deleteUser({ username: 'u/1' });
      expect(out.ok).to.equal(true);
      const [url, init] = fetchFn.firstCall.args;
      expect(url).to.equal('http://server/api/v1/users/u%2F1');
      expect(init.method).to.equal('DELETE');
    });

    it('returns a non-throwing failure object when the API rejects (teardown is best-effort)', async () => {
      const fetchFn = sinon.stub().resolves(fail(404, 'no such user'));
      const mgr = new UserManager({ baseUrl: 'http://server', admin: { username: 'm', password: 'p' }, fetchFn });
      const out = await mgr.deleteUser({ username: 'missing' });
      expect(out.ok).to.equal(false);
      expect(out.status).to.equal(404);
    });
  });
});
