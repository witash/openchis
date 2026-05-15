'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const baseline = require('../scenarios/baseline');
const initialVsOngoing = require('../scenarios/initial-vs-ongoing');

describe('scenarios', () => {
  describe('baseline.buildSpecsForProtocol', () => {
    it('returns one spec per user, each with a single initial sync', () => {
      const specs = baseline.buildSpecsForProtocol({
        runId: 'r1', userCount: 5, protocol: 'pg-sync',
      });
      expect(specs).to.have.length(5);
      for (const s of specs) {
        expect(s.protocol).to.equal('pg-sync');
        expect(s.syncs).to.deep.equal([{ kind: 'initial' }]);
      }
    });

    it('uses the predictable perf-chw-<runId>-<i> username for each spec', () => {
      const specs = baseline.buildSpecsForProtocol({
        runId: 'r1', userCount: 3, protocol: 'pg-sync',
      });
      expect(specs.map((s) => s.username)).to.deep.equal([
        'perf-chw-r1-0',
        'perf-chw-r1-1',
        'perf-chw-r1-2',
      ]);
      for (const s of specs) {
        expect(s.id).to.equal(s.username);
        expect(s.password).to.equal(baseline.DEFAULT_CHW_PASSWORD);
      }
    });

    it('does not attach reports or facility_id — Phase 1 is pull-only', () => {
      const specs = baseline.buildSpecsForProtocol({
        runId: 'r1', userCount: 2, protocol: 'pg-sync',
      });
      for (const s of specs) {
        expect(s).to.not.have.property('reports');
        expect(s).to.not.have.property('facility_id');
      }
    });
  });

  describe('baseline.run', () => {
    it('calls runSetup exactly once before measurements and never invokes a teardown helper', async () => {
      const runSetupFn = sinon.stub().resolves();
      // The runner.runAll dependency reaches into pouchdb-adapter-memory; we
      // short-circuit by handing an empty protocols list, leaving runSetup as
      // the only observable side-effect.
      await baseline.run({
        baseUrl: 'http://server',
        admin: { username: 'a', password: 'b' },
        userCount: 3,
        runId: 'r1',
        protocols: [],
        runSetupFn,
      });
      expect(runSetupFn.calledOnce).to.equal(true);
      const args = runSetupFn.firstCall.args[0];
      expect(args.baseUrl).to.equal('http://server');
      expect(args.userCount).to.equal(3);
      expect(args.runId).to.equal('r1');
    });
  });

  describe('initial-vs-ongoing.splitWarmed', () => {
    it('splits the user pool by the configured fraction', () => {
      expect(initialVsOngoing.splitWarmed({ userCount: 10, warmedFraction: 0.8 })).to.deep.equal({ warmed: 8, cold: 2 });
      expect(initialVsOngoing.splitWarmed({ userCount: 5, warmedFraction: 0.5 })).to.deep.equal({ warmed: 2, cold: 3 });
      expect(initialVsOngoing.splitWarmed({ userCount: 5, warmedFraction: 1 })).to.deep.equal({ warmed: 5, cold: 0 });
      expect(initialVsOngoing.splitWarmed({ userCount: 5, warmedFraction: 0 })).to.deep.equal({ warmed: 0, cold: 5 });
    });
  });

  describe('initial-vs-ongoing.buildSpecs', () => {
    it('gives warmed users two syncs and cold users one', () => {
      const specs = initialVsOngoing.buildSpecs({
        runId: 'r1', userCount: 10, protocol: 'pg-sync', warmedFraction: 0.8,
      });
      expect(specs).to.have.length(10);
      const warmed = specs.filter((s) => s.syncs.length === 2);
      const cold = specs.filter((s) => s.syncs.length === 1);
      expect(warmed).to.have.length(8);
      expect(cold).to.have.length(2);
      expect(warmed[0].syncs.map((s) => s.kind)).to.deep.equal(['initial', 'ongoing']);
      expect(cold[0].syncs.map((s) => s.kind)).to.deep.equal(['initial']);
    });

    it('uses the predictable perf-chw-<runId>-<i> username for each spec', () => {
      const specs = initialVsOngoing.buildSpecs({
        runId: 'r1', userCount: 4, protocol: 'pg-sync', warmedFraction: 0.5,
      });
      expect(specs.map((s) => s.username)).to.deep.equal([
        'perf-chw-r1-0',
        'perf-chw-r1-1',
        'perf-chw-r1-2',
        'perf-chw-r1-3',
      ]);
    });
  });

  describe('initial-vs-ongoing.run', () => {
    it('calls runSetup exactly once and never invokes a teardown helper', async () => {
      const runSetupFn = sinon.stub().resolves();
      await initialVsOngoing.run({
        baseUrl: 'http://server',
        admin: { username: 'a', password: 'b' },
        userCount: 3,
        runId: 'r1',
        protocols: [],
        warmedFraction: 0.5,
        runSetupFn,
      });
      expect(runSetupFn.calledOnce).to.equal(true);
    });
  });
});
