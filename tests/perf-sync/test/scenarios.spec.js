'use strict';

const { expect } = require('chai');
const baseline = require('../scenarios/baseline');
const initialVsOngoing = require('../scenarios/initial-vs-ongoing');

describe('scenarios', () => {
  describe('baseline.buildSpecsForProtocol', () => {
    it('returns one spec per user, each with a single initial sync', () => {
      const specs = baseline.buildSpecsForProtocol({
        runId: 'r1', userCount: 5, userPrefix: 'perf-test', protocol: 'pg-sync', seed: 1,
      });
      expect(specs).to.have.length(5);
      for (const s of specs) {
        expect(s.protocol).to.equal('pg-sync');
        expect(s.syncs).to.deep.equal([{ kind: 'initial' }]);
        expect(s.id).to.match(/^perf-test-r1-/);
      }
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
        runId: 'r1', userCount: 10, userPrefix: 'perf-test', protocol: 'pg-sync', warmedFraction: 0.8,
      });
      expect(specs).to.have.length(10);
      const warmed = specs.filter((s) => s.syncs.length === 2);
      const cold = specs.filter((s) => s.syncs.length === 1);
      expect(warmed).to.have.length(8);
      expect(cold).to.have.length(2);
      // warmed flow: initial, then ongoing
      expect(warmed[0].syncs.map((s) => s.kind)).to.deep.equal(['initial', 'ongoing']);
      expect(cold[0].syncs.map((s) => s.kind)).to.deep.equal(['initial']);
    });
  });
});
