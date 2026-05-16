const chai = require('chai');
const { expect } = chai;

const {
  transform,
  isContactDoc,
  isSystemDoc,
  getContactType,
  getParentId,
  getSubject,
  getDocType,
} = require('../src');

describe('postgres-sync transform', () => {
  describe('isContactDoc', () => {
    it('returns true for hardcoded contact types', () => {
      expect(isContactDoc({ type: 'person' })).to.equal(true);
      expect(isContactDoc({ type: 'clinic' })).to.equal(true);
      expect(isContactDoc({ type: 'health_center' })).to.equal(true);
      expect(isContactDoc({ type: 'district_hospital' })).to.equal(true);
    });

    it('returns true for type=contact (configurable hierarchy)', () => {
      expect(isContactDoc({ type: 'contact', contact_type: 'patient' })).to.equal(true);
    });

    it('returns false for non-contact docs', () => {
      expect(isContactDoc({ type: 'data_record' })).to.equal(false);
      expect(isContactDoc({ type: 'user-settings' })).to.equal(false);
      expect(isContactDoc(null)).to.equal(false);
      expect(isContactDoc(undefined)).to.equal(false);
      expect(isContactDoc('string')).to.equal(false);
    });
  });

  describe('isSystemDoc', () => {
    it('returns false for null/undefined', () => {
      expect(isSystemDoc(null)).to.equal(false);
      expect(isSystemDoc(undefined)).to.equal(false);
    });

    it('returns true for known system ids', () => {
      expect(isSystemDoc({ _id: 'settings' })).to.equal(true);
      expect(isSystemDoc({ _id: 'branding' })).to.equal(true);
    });

    it('returns true for forms and translations', () => {
      expect(isSystemDoc({ type: 'form' })).to.equal(true);
      expect(isSystemDoc({ type: 'translations' })).to.equal(true);
    });
  });

  describe('getContactType', () => {
    it('returns contact_type for type=contact docs', () => {
      expect(getContactType({ type: 'contact', contact_type: 'patient' })).to.equal('patient');
    });

    it('returns the type itself for hardcoded contact types', () => {
      expect(getContactType({ type: 'person' })).to.equal('person');
      expect(getContactType({ type: 'clinic' })).to.equal('clinic');
    });

    it('returns null for non-contact docs', () => {
      expect(getContactType({ type: 'data_record' })).to.equal(null);
    });

    it('returns null for falsy input', () => {
      expect(getContactType(null)).to.equal(null);
      expect(getContactType(undefined)).to.equal(null);
    });

    it('returns null for type=contact without a contact_type string', () => {
      expect(getContactType({ type: 'contact' })).to.equal(null);
      expect(getContactType({ type: 'contact', contact_type: 7 })).to.equal(null);
    });
  });

  describe('getParentId', () => {
    it('extracts parent._id from a nested reference', () => {
      expect(getParentId({ parent: { _id: 'parent-1' } })).to.equal('parent-1');
    });

    it('returns parent if parent is a string id', () => {
      expect(getParentId({ parent: 'parent-2' })).to.equal('parent-2');
    });

    it('returns null when there is no parent', () => {
      expect(getParentId({})).to.equal(null);
      expect(getParentId({ parent: null })).to.equal(null);
      expect(getParentId({ parent: {} })).to.equal(null);
    });

    it('returns null for null input', () => {
      expect(getParentId(null)).to.equal(null);
    });
  });

  describe('getSubject', () => {
    it('returns null for null/undefined input', () => {
      expect(getSubject(null)).to.equal(null);
      expect(getSubject(undefined)).to.equal(null);
    });

    it('returns the contact doc id for contact docs', () => {
      expect(getSubject({ _id: 'p1', type: 'person' })).to.equal('p1');
    });

    it('returns null for a contact doc with no id', () => {
      expect(getSubject({ type: 'person' })).to.equal(null);
    });

    it('extracts patient subjects from fields on data_record reports', () => {
      const doc = { type: 'data_record', form: 'p', fields: { patient_id: 'patient-7' } };
      expect(getSubject(doc)).to.equal('patient-7');
    });

    it('prefers top-level patient_id over fields.patient_id on a report', () => {
      const doc = {
        type: 'data_record',
        form: 'p',
        patient_id: 'top-level',
        fields: { patient_id: 'in-fields' },
      };
      expect(getSubject(doc)).to.equal('top-level');
    });

    it('falls back to place_id and fields.place_id when no patient ref is set', () => {
      expect(getSubject({ type: 'data_record', form: 'p', place_id: 'place-1' }))
        .to.equal('place-1');
      expect(getSubject({ type: 'data_record', form: 'p', fields: { place_id: 'place-2' } }))
        .to.equal('place-2');
    });

    it('falls back to fields.patient_uuid after patient/place fields are exhausted', () => {
      const doc = { type: 'data_record', form: 'p', fields: { patient_uuid: 'pu-1' } };
      expect(getSubject(doc)).to.equal('pu-1');
    });

    it('falls back to contact._id when no patient/place reference exists on a report', () => {
      const doc = { type: 'data_record', form: 'p', contact: { _id: 'submitter-1' } };
      expect(getSubject(doc)).to.equal('submitter-1');
    });

    it('returns _unassigned for a data_record with nothing extractable', () => {
      expect(getSubject({ type: 'data_record', form: 'p' })).to.equal('_unassigned');
    });

    it('returns the registration submitter for reports with patient errors', () => {
      const doc = {
        type: 'data_record',
        form: 'p',
        contact: { _id: 'sender' },
        errors: [{ code: 'registration_not_found' }],
        patient_id: 'unused',
      };
      expect(getSubject(doc)).to.equal('sender');
    });

    it('returns the registration submitter for reports with invalid_patient_id errors', () => {
      const doc = {
        type: 'data_record',
        form: 'p',
        contact: { _id: 'sender' },
        errors: [{ code: 'invalid_patient_id' }],
        patient_id: 'unused',
      };
      expect(getSubject(doc)).to.equal('sender');
    });

    it('ignores unrelated error codes on a report', () => {
      const doc = {
        type: 'data_record',
        form: 'p',
        contact: { _id: 'sender' },
        errors: [{ code: 'something_else' }],
        patient_id: 'real-patient',
      };
      expect(getSubject(doc)).to.equal('real-patient');
    });

    it('returns the message contact for incoming sms_message records', () => {
      const doc = {
        type: 'data_record',
        sms_message: { from: '+1' },
        contact: { _id: 'msg-from' },
      };
      expect(getSubject(doc)).to.equal('msg-from');
    });

    it('returns _unassigned for an sms_message with no contact', () => {
      const doc = { type: 'data_record', sms_message: { from: '+1' } };
      expect(getSubject(doc)).to.equal('_unassigned');
    });

    it('returns the first kujua_message task contact', () => {
      const doc = {
        type: 'data_record',
        kujua_message: true,
        tasks: [{ messages: [{ contact: { _id: 'kujua-c' } }] }],
      };
      expect(getSubject(doc)).to.equal('kujua-c');
    });

    it('returns _unassigned for a kujua_message without a task contact', () => {
      const doc = { type: 'data_record', kujua_message: true };
      expect(getSubject(doc)).to.equal('_unassigned');
    });

    it('returns the user field for task docs', () => {
      expect(getSubject({ type: 'task', user: 'org.couchdb.user:eve' }))
        .to.equal('org.couchdb.user:eve');
    });

    it('returns null for a task doc without a user', () => {
      expect(getSubject({ type: 'task' })).to.equal(null);
    });

    it('returns the owner field for target docs', () => {
      expect(getSubject({ type: 'target', owner: 'contact-77' })).to.equal('contact-77');
    });

    it('returns null for a target doc without an owner', () => {
      expect(getSubject({ type: 'target' })).to.equal(null);
    });

    it('returns null for known system docs', () => {
      expect(getSubject({ _id: 'settings' })).to.equal(null);
      expect(getSubject({ _id: 'resources' })).to.equal(null);
      expect(getSubject({ type: 'translations' })).to.equal(null);
      expect(getSubject({ type: 'form' })).to.equal(null);
    });

    it('returns null for an unknown doc type', () => {
      expect(getSubject({ type: 'mystery' })).to.equal(null);
    });
  });

  describe('getDocType', () => {
    it('returns the type field', () => {
      expect(getDocType({ type: 'data_record' })).to.equal('data_record');
    });

    it('returns null when type is missing or non-string', () => {
      expect(getDocType({})).to.equal(null);
      expect(getDocType({ type: 1 })).to.equal(null);
      expect(getDocType(null)).to.equal(null);
    });
  });

  describe('transform (pure doc → records)', () => {
    it('returns null for falsy / id-less input', () => {
      expect(transform(null)).to.equal(null);
      expect(transform(undefined)).to.equal(null);
      expect(transform({})).to.equal(null);
      expect(transform({ _id: 'a' })).to.equal(null); // missing _rev
    });

    it('shapes a non-contact data_record into a single medicDocument record', () => {
      const doc = {
        _id: 'report-1',
        _rev: '1-abc',
        type: 'data_record',
        form: 'pregnancy',
        fields: { patient_id: 'patient-9' },
      };
      const record = transform(doc);

      expect(record).to.have.property('medicDocument');
      expect(record).to.not.have.property('contact');
      expect(record.medicDocument).to.deep.equal({
        _id: 'report-1',
        _rev: '1-abc',
        couchdb_seq: null,
        doc,
        subject: 'patient-9',
        type: 'data_record',
        deleted: false,
      });
    });

    it('emits a contact record (without lineage) for contact-type docs', () => {
      const doc = {
        _id: 'clinic-1',
        _rev: '1-aa',
        type: 'clinic',
        name: 'East Clinic',
        parent: { _id: 'district-1' },
        phone: '+1234567890',
      };
      const record = transform(doc);

      expect(record.medicDocument.subject).to.equal('clinic-1');
      expect(record.medicDocument.type).to.equal('clinic');
      expect(record.contact).to.deep.equal({
        id: 'clinic-1',
        type: 'clinic',
        contact_type: 'clinic',
        parent: 'district-1',
        name: 'East Clinic',
        muted: null,
        phone: '+1234567890',
        shortcode: null,
      });
      expect(record.contact).to.not.have.property('lineage');
    });

    it('stamps muted as a Date when present', () => {
      const doc = { _id: 'p1', _rev: '1', type: 'person', muted: '2024-05-01T12:00:00Z' };
      const record = transform(doc);

      expect(record.contact.muted).to.be.instanceOf(Date);
      expect(record.contact.muted.toISOString()).to.equal('2024-05-01T12:00:00.000Z');
    });

    it('shapes a tombstone (deleted: true) record with subject/type null', () => {
      const record = transform({ _id: 'doc-1', _rev: '3-tomb', _deleted: true });
      expect(record).to.have.property('medicDocument');
      expect(record).to.not.have.property('contact');
      expect(record.medicDocument).to.deep.equal({
        _id: 'doc-1',
        _rev: '3-tomb',
        couchdb_seq: null,
        doc: { _id: 'doc-1', _rev: '3-tomb', _deleted: true },
        subject: null,
        type: null,
        deleted: true,
      });
    });

    it('falls back to _rev "0" for a tombstone with no _rev', () => {
      const record = transform({ _id: 'doc-1', _deleted: true });
      expect(record.medicDocument._rev).to.equal('0');
      expect(record.medicDocument.doc._rev).to.equal('0');
    });

    it('preserves system docs with subject = null', () => {
      const record = transform({ _id: 'settings', _rev: '1-s', type: 'foo' });
      expect(record.medicDocument.subject).to.equal(null);
      expect(record).to.not.have.property('contact');
    });

    it('threads couchdbSeq through options when provided', () => {
      const record = transform(
        { _id: 'd', _rev: '1', type: 'data_record', form: 'a' },
        { couchdbSeq: 42 }
      );
      expect(record.medicDocument.couchdb_seq).to.equal('42');
    });
  });
});
