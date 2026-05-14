'use strict';

const { expect } = require('chai');
const fixtures = require('../lib/fixtures');

describe('fixtures', () => {
  describe('deriveSubject (canonical CHT rules)', () => {
    it('returns _id for contact-type documents', () => {
      for (const type of ['person', 'clinic', 'health_center', 'district_hospital', 'contact']) {
        expect(fixtures.deriveSubject({ _id: 'abc', type })).to.equal('abc');
      }
    });

    it('returns patient_id when present on a data_record', () => {
      const doc = { type: 'data_record', form: 'pregnancy', patient_id: '10072' };
      expect(fixtures.deriveSubject(doc)).to.equal('10072');
    });

    it('falls back to fields.patient_id', () => {
      const doc = { type: 'data_record', form: 'pregnancy', fields: { patient_id: 'p99' } };
      expect(fixtures.deriveSubject(doc)).to.equal('p99');
    });

    it('falls back to fields.patient_uuid', () => {
      const doc = { type: 'data_record', form: 'pregnancy', fields: { patient_uuid: 'u-1' } };
      expect(fixtures.deriveSubject(doc)).to.equal('u-1');
    });

    it('falls back to fields.place_id', () => {
      const doc = { type: 'data_record', form: 'visit', fields: { place_id: 'hc1' } };
      expect(fixtures.deriveSubject(doc)).to.equal('hc1');
    });

    it('falls back to contact._id when nothing else resolves', () => {
      const doc = { type: 'data_record', form: 'pregnancy', contact: { _id: 'contact-1' } };
      expect(fixtures.deriveSubject(doc)).to.equal('contact-1');
    });

    it('uses contact._id when the report has a registration_not_found error', () => {
      const doc = {
        type: 'data_record',
        form: 'pregnancy',
        patient_id: '10072',
        contact: { _id: 'contact-2' },
        errors: [{ code: 'registration_not_found' }],
      };
      expect(fixtures.deriveSubject(doc)).to.equal('contact-2');
    });

    it('uses owner for target docs', () => {
      expect(fixtures.deriveSubject({ type: 'target', owner: 'u1' })).to.equal('u1');
    });

    it('uses user (or owner) for task docs', () => {
      expect(fixtures.deriveSubject({ type: 'task', user: 'u1' })).to.equal('u1');
    });

    it('returns _unassigned when nothing resolves', () => {
      expect(fixtures.deriveSubject({ type: 'data_record', form: 'pregnancy' })).to.equal('_unassigned');
      expect(fixtures.deriveSubject({})).to.equal('_unassigned');
    });
  });

  describe('makeRng (seeded PRNG)', () => {
    it('produces a deterministic sequence for a given seed', () => {
      const a = fixtures.makeRng(123);
      const b = fixtures.makeRng(123);
      const seqA = Array.from({ length: 10 }, a);
      const seqB = Array.from({ length: 10 }, b);
      expect(seqA).to.deep.equal(seqB);
    });

    it('produces different sequences for different seeds', () => {
      const a = fixtures.makeRng(1);
      const b = fixtures.makeRng(2);
      const seqA = Array.from({ length: 5 }, a);
      const seqB = Array.from({ length: 5 }, b);
      expect(seqA).to.not.deep.equal(seqB);
    });
  });

  describe('generateUserHierarchy', () => {
    it('builds district -> health_center -> user contact with consistent parent links', () => {
      const h = fixtures.generateUserHierarchy({ userIndex: 0, runId: 'r1', seed: 1 });
      expect(h.district.type).to.equal('district_hospital');
      expect(h.healthCenter.type).to.equal('health_center');
      expect(h.userContact.type).to.equal('person');
      expect(h.healthCenter.parent._id).to.equal(h.district._id);
      expect(h.userContact.parent._id).to.equal(h.healthCenter._id);
      expect(h.userContact.parent.parent._id).to.equal(h.district._id);
      expect(h.contacts).to.have.length(3);
    });

    it('generates distinct ids per userIndex within the same runId', () => {
      const a = fixtures.generateUserHierarchy({ userIndex: 0, runId: 'r1', seed: 1 });
      const b = fixtures.generateUserHierarchy({ userIndex: 1, runId: 'r1', seed: 1 });
      expect(a.userContact._id).to.not.equal(b.userContact._id);
      expect(a.district._id).to.not.equal(b.district._id);
    });

    it('is deterministic for a given (userIndex, runId, seed) triple', () => {
      const a = fixtures.generateUserHierarchy({ userIndex: 2, runId: 'r9', seed: 42 });
      const b = fixtures.generateUserHierarchy({ userIndex: 2, runId: 'r9', seed: 42 });
      expect(a).to.deep.equal(b);
    });
  });

  describe('generateReports', () => {
    let hierarchy;
    beforeEach(() => {
      hierarchy = fixtures.generateUserHierarchy({ userIndex: 0, runId: 'r1', seed: 1 });
    });

    it('produces the requested count of data_record docs', () => {
      const reports = fixtures.generateReports({ count: 7, userIndex: 0, runId: 'r1', hierarchy, seed: 1 });
      expect(reports).to.have.length(7);
      for (const r of reports) {
        expect(r.type).to.equal('data_record');
        expect(r.form).to.be.oneOf(fixtures.FORMS);
        expect(r.contact._id).to.equal(hierarchy.userContact._id);
        expect(r.fields).to.have.property('patient_uuid');
      }
    });

    it('generates unique ids across reports', () => {
      const reports = fixtures.generateReports({ count: 25, userIndex: 0, runId: 'r1', hierarchy, seed: 1 });
      const ids = new Set(reports.map((r) => r._id));
      expect(ids.size).to.equal(25);
    });

    it('reports derive their subject to the patient_uuid (canonical rule)', () => {
      const reports = fixtures.generateReports({ count: 3, userIndex: 0, runId: 'r1', hierarchy, seed: 1 });
      for (const r of reports) {
        expect(fixtures.deriveSubject(r)).to.equal(r.fields.patient_uuid);
      }
    });
  });

  describe('generateUserFixtures', () => {
    it('produces hierarchy and reports together', () => {
      const f = fixtures.generateUserFixtures({ userIndex: 3, runId: 'rA', seed: 7, reportsPerUser: 4 });
      expect(f.hierarchy.userContact.type).to.equal('person');
      expect(f.reports).to.have.length(4);
      // sanity check: reports authorize through the patient_uuid, not the user's contact.
      expect(fixtures.deriveSubject(f.reports[0])).to.equal(f.reports[0].fields.patient_uuid);
    });

    it('is deterministic across runs', () => {
      const a = fixtures.generateUserFixtures({ userIndex: 3, runId: 'rA', seed: 7, reportsPerUser: 4 });
      const b = fixtures.generateUserFixtures({ userIndex: 3, runId: 'rA', seed: 7, reportsPerUser: 4 });
      expect(a).to.deep.equal(b);
    });
  });

  describe('generateUserSpec', () => {
    it('names users with the configured prefix + runId + index', () => {
      const spec = fixtures.generateUserSpec({ userIndex: 7, runId: 'r1', userPrefix: 'perf-test' });
      expect(spec.username).to.equal('perf-test-r1-7');
      expect(spec.password).to.be.a('string').and.have.length.greaterThan(8);
      expect(spec.roles).to.deep.equal(['chw']);
    });
  });
});
