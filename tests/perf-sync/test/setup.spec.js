'use strict';

const path = require('path');
const { expect } = require('chai');
const sinon = require('sinon');

const setup = require('../lib/setup');

// A minimal stand-in for what many-users.js returns: one
// district-hospital subtree per call, with the same shape the real
// upstream produces. The wrapper only cares about (designId, children,
// getDoc, amount), not the full doc bodies, so the stubs return tags
// that make assertions easy.
const STUB_PASSWORD = 'password';

const makeStubUpstream = () => {
  return () => [
    {
      designId: 'district-hospital',
      amount: 1,
      getDoc: () => ({ type: 'district_hospital', name: 'dh' }),
      children: [
        {
          designId: 'health-center',
          amount: 1,
          getDoc: () => ({ type: 'health_center', name: 'hc' }),
          children: [
            {
              designId: 'household',
              amount: 1,
              getDoc: () => ({ type: 'clinic', name: 'household' }),
              children: [
                {
                  designId: 'woman-person',
                  amount: 1,
                  getDoc: () => ({ type: 'person', role: 'patient' }),
                  children: [
                    {
                      designId: 'pregnancy-danger-report',
                      amount: 1,
                      getDoc: () => ({ type: 'data_record', form: 'pregnancy_danger_sign' }),
                    },
                  ],
                },
                { designId: 'child-person', amount: 1, getDoc: () => ({ type: 'person' }) },
                { designId: 'infant-person', amount: 1, getDoc: () => ({ type: 'person' }) },
                { designId: 'patient-person', amount: 1, getDoc: () => ({ type: 'person' }) },
              ],
            },
            {
              designId: 'chw',
              amount: 1,
              getDoc: () => ({ type: 'person', role: 'chw' }),
              children: [
                { designId: '_users chw', amount: 1, db: '_users', getDoc: () => ({ type: 'user' }) },
                { designId: 'user-settings chw', amount: 1, db: 'medic', getDoc: () => ({ type: 'user-settings' }) },
                { designId: 'Telemetry', amount: 10, db: 'medic-users-meta', getDoc: () => ({ type: 'telemetry' }) },
                { designId: 'tasks', amount: 100, getDoc: () => ({ type: 'task' }) },
              ],
            },
          ],
        },
        {
          designId: 'chw-supervisor',
          amount: 1,
          getDoc: () => ({ type: 'person', role: 'chw_supervisor' }),
          children: [
            { designId: '_users super', amount: 1, db: '_users', getDoc: () => ({ type: 'user' }) },
            { designId: 'user-settings super', amount: 1, db: 'medic', getDoc: () => ({ type: 'user-settings' }) },
            { designId: 'Telemetry', amount: 10, db: 'medic-users-meta', getDoc: () => ({ type: 'telemetry' }) },
          ],
        },
      ],
    },
  ];
};

const importDesign = async () => {
  // Cache-bust on every test so the wrapper's module-level `config` resets.
  const url = require('url').pathToFileURL(
    path.resolve(__dirname, '../designs/perf-many-users.js'),
  );
  return import(`${url.href}?cb=${Math.random()}`);
};

describe('setup', () => {
  describe('buildCouchUrl', () => {
    it('folds admin creds into the URL as basic-auth components', () => {
      const url = setup.buildCouchUrl({ baseUrl: 'http://server:5984', admin: { username: 'medic', password: 'pwd' } });
      expect(url).to.equal('http://medic:pwd@server:5984/');
    });

    it('encodes special characters in the admin credentials', () => {
      const url = setup.buildCouchUrl({ baseUrl: 'http://server', admin: { username: 'a@b', password: 'p w/d' } });
      expect(url).to.contain('a%40b');
      expect(url).to.contain('p%20w%2Fd');
    });
  });

  describe('design wrapper (perf-many-users)', () => {
    it('produces exactly userCount district-hospital subtrees', async () => {
      const designModule = await importDesign();
      designModule.configure({ upstreamDesign: makeStubUpstream(), userCount: 3, runId: 'r1' });
      const designs = designModule.default({ username: 'admin' });
      expect(designs).to.have.length(3);
      for (const d of designs) {
        expect(d.designId).to.equal('district-hospital');
      }
    });

    it('overrides only the CHW username with perf-chw-<runId>-<i>', async () => {
      const designModule = await importDesign();
      designModule.configure({ upstreamDesign: makeStubUpstream(), userCount: 4, runId: 'demo' });
      const designs = designModule.default({ username: 'admin' });
      const chwUsernames = designs.map((dh) => {
        const hc = dh.children.find((c) => c.designId === 'health-center');
        const chw = hc.children.find((c) => c.designId === 'chw');
        return chw.getDoc({}).username;
      });
      expect(chwUsernames).to.deep.equal([
        'perf-chw-demo-0',
        'perf-chw-demo-1',
        'perf-chw-demo-2',
        'perf-chw-demo-3',
      ]);
    });

    it('preserves the upstream hierarchy / per-CHW counts', async () => {
      const designModule = await importDesign();
      designModule.configure({ upstreamDesign: makeStubUpstream(), userCount: 1, runId: 'r1' });
      const [dh] = designModule.default({ username: 'admin' });
      const hc = dh.children.find((c) => c.designId === 'health-center');
      const household = hc.children.find((c) => c.designId === 'household');
      const woman = household.children.find((c) => c.designId === 'woman-person');
      const pregnancy = woman.children.find((c) => c.designId === 'pregnancy-danger-report');
      const chw = hc.children.find((c) => c.designId === 'chw');
      const tasks = chw.children.find((c) => c.designId === 'tasks');

      expect(pregnancy.amount).to.equal(1);
      expect(tasks.amount).to.equal(100);
      // _users + user-settings + telemetry + tasks
      expect(chw.children).to.have.length(4);
      // patient subtree
      expect(household.children.map((c) => c.designId)).to.have.members([
        'woman-person', 'child-person', 'infant-person', 'patient-person',
      ]);
      // chw-supervisor sibling
      expect(dh.children.map((c) => c.designId)).to.have.members(['health-center', 'chw-supervisor']);
    });

    it('throws when configure() was never called with an upstream factory', async () => {
      const designModule = await importDesign();
      // Don't configure upstreamDesign.
      designModule.configure({ userCount: 1, runId: 'r1' });
      expect(() => designModule.default({ username: 'admin' })).to.throw(/upstreamDesign/);
    });
  });

  describe('runSetup', () => {
    let env;
    beforeEach(() => { env = {}; });

    it('configures the design with upstream + counts and forwards designs to Docs.createDocs', async () => {
      const createDocs = sinon.stub().resolves();
      const configure = sinon.stub();
      const defaultDesign = sinon.stub().returns([{ designId: 'fake' }]);
      const upstreamDefault = sinon.stub();
      const opts = {
        baseUrl: 'http://server',
        admin: { username: 'a', password: 'b' },
        userCount: 5,
        runId: 'demo',
        importDocs: async () => ({ Docs: { createDocs } }),
        importDesign: async () => ({ default: defaultDesign, configure }),
        importUpstream: async () => ({ default: upstreamDefault }),
        env,
      };

      const result = await setup.runSetup(opts);

      expect(configure.calledOnce).to.equal(true);
      const cfgArg = configure.firstCall.args[0];
      expect(cfgArg.upstreamDesign).to.equal(upstreamDefault);
      expect(cfgArg.userCount).to.equal(5);
      expect(cfgArg.runId).to.equal('demo');

      expect(defaultDesign.calledOnce).to.equal(true);
      expect(createDocs.calledOnce).to.equal(true);
      expect(createDocs.firstCall.args[0]).to.deep.equal([{ designId: 'fake' }]);

      expect(env.COUCH_URL).to.equal('http://a:b@server/');
      expect(result).to.deep.equal({
        runId: 'demo',
        userCount: 5,
        usernames: ['perf-chw-demo-0', 'perf-chw-demo-1', 'perf-chw-demo-2', 'perf-chw-demo-3', 'perf-chw-demo-4'],
      });
    });

    it('throws when baseUrl/admin/userCount/runId are missing or invalid', async () => {
      const stubImports = {
        importDocs: async () => ({ Docs: { createDocs: sinon.stub().resolves() } }),
        importDesign: async () => ({ default: sinon.stub().returns([]), configure: sinon.stub() }),
        importUpstream: async () => ({ default: sinon.stub() }),
        env,
      };
      for (const missing of [
        { ...stubImports, baseUrl: '', admin: { username: 'a' }, userCount: 1, runId: 'r' },
        { ...stubImports, baseUrl: 'http://x', admin: null, userCount: 1, runId: 'r' },
        { ...stubImports, baseUrl: 'http://x', admin: { username: 'a' }, userCount: 0, runId: 'r' },
        { ...stubImports, baseUrl: 'http://x', admin: { username: 'a' }, userCount: 1, runId: '' },
      ]) {
        let err;
        try { await setup.runSetup(missing); } catch (e) { err = e; }
        expect(err, JSON.stringify(missing)).to.be.an('error');
      }
    });
  });

  describe('stitchPerfUsernames', () => {
    it('keeps only CHW person docs and emits (username, contact_id) pairs', () => {
      const docs = [
        { type: 'district_hospital', _id: 'dh-1' },
        { type: 'person', role: 'chw', _id: 'p-1', username: 'perf-chw-r1-0' },
        { type: 'person', role: 'chw_supervisor', _id: 'p-2' },
        { type: 'person', role: 'chw', _id: 'p-3', username: 'perf-chw-r1-1' },
        { type: 'data_record', _id: 'r-1' },
      ];
      const out = setup.stitchPerfUsernames({ docs, runId: 'r1', userCount: 2 });
      expect(out).to.deep.equal([
        { username: 'perf-chw-r1-0', contact_id: 'p-1' },
        { username: 'perf-chw-r1-1', contact_id: 'p-3' },
      ]);
    });

    it('throws when the chw count does not match userCount', () => {
      const docs = [
        { type: 'person', role: 'chw', _id: 'p-1', username: 'perf-chw-r1-0' },
      ];
      expect(() => setup.stitchPerfUsernames({ docs, runId: 'r1', userCount: 2 })).to.throw(/expected 2/);
    });
  });
});
