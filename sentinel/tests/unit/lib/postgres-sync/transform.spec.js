const transform = require('../../../../src/lib/postgres-sync/transform');

describe('postgres-sync transform', () => {
  describe('isContactDoc', () => {
    it('returns true for hardcoded contact types', () => {
      expect(transform.isContactDoc({ type: 'person' })).to.equal(true);
      expect(transform.isContactDoc({ type: 'clinic' })).to.equal(true);
      expect(transform.isContactDoc({ type: 'health_center' })).to.equal(true);
      expect(transform.isContactDoc({ type: 'district_hospital' })).to.equal(true);
    });

    it('returns true for type=contact (configurable hierarchy)', () => {
      expect(transform.isContactDoc({ type: 'contact', contact_type: 'patient' })).to.equal(true);
    });

    it('returns false for non-contact docs', () => {
      expect(transform.isContactDoc({ type: 'data_record' })).to.equal(false);
      expect(transform.isContactDoc({ type: 'user-settings' })).to.equal(false);
      expect(transform.isContactDoc(null)).to.equal(false);
      expect(transform.isContactDoc(undefined)).to.equal(false);
      expect(transform.isContactDoc('string')).to.equal(false);
    });
  });

  describe('isSystemDoc', () => {
    it('returns false for null/undefined', () => {
      expect(transform.isSystemDoc(null)).to.equal(false);
      expect(transform.isSystemDoc(undefined)).to.equal(false);
    });

    it('returns true for known system ids', () => {
      expect(transform.isSystemDoc({ _id: 'settings' })).to.equal(true);
      expect(transform.isSystemDoc({ _id: 'branding' })).to.equal(true);
    });

    it('returns true for forms and translations', () => {
      expect(transform.isSystemDoc({ type: 'form' })).to.equal(true);
      expect(transform.isSystemDoc({ type: 'translations' })).to.equal(true);
    });
  });

  describe('getContactType', () => {
    it('returns contact_type for type=contact docs', () => {
      expect(transform.getContactType({ type: 'contact', contact_type: 'patient' })).to.equal('patient');
    });

    it('returns the type itself for hardcoded contact types', () => {
      expect(transform.getContactType({ type: 'person' })).to.equal('person');
      expect(transform.getContactType({ type: 'clinic' })).to.equal('clinic');
    });

    it('returns null for non-contact docs', () => {
      expect(transform.getContactType({ type: 'data_record' })).to.equal(null);
    });

    it('returns null for falsy input', () => {
      expect(transform.getContactType(null)).to.equal(null);
      expect(transform.getContactType(undefined)).to.equal(null);
    });

    it('returns null for type=contact without a contact_type string', () => {
      expect(transform.getContactType({ type: 'contact' })).to.equal(null);
      expect(transform.getContactType({ type: 'contact', contact_type: 7 })).to.equal(null);
    });
  });

  describe('getParentId', () => {
    it('extracts parent._id from a nested reference', () => {
      expect(transform.getParentId({ parent: { _id: 'parent-1' } })).to.equal('parent-1');
    });

    it('returns parent if parent is a string id', () => {
      expect(transform.getParentId({ parent: 'parent-2' })).to.equal('parent-2');
    });

    it('returns null when there is no parent', () => {
      expect(transform.getParentId({})).to.equal(null);
      expect(transform.getParentId({ parent: null })).to.equal(null);
      expect(transform.getParentId({ parent: {} })).to.equal(null);
    });

    it('returns null for null input', () => {
      expect(transform.getParentId(null)).to.equal(null);
    });
  });

  describe('getSubject', () => {
    it('returns null for null/undefined input', () => {
      expect(transform.getSubject(null)).to.equal(null);
      expect(transform.getSubject(undefined)).to.equal(null);
    });

    it('returns the contact doc id for contact docs', () => {
      expect(transform.getSubject({ _id: 'p1', type: 'person' })).to.equal('p1');
    });

    it('returns null for a contact doc with no id', () => {
      expect(transform.getSubject({ type: 'person' })).to.equal(null);
    });

    it('extracts patient subjects from fields on data_record reports', () => {
      const doc = { type: 'data_record', form: 'p', fields: { patient_id: 'patient-7' } };
      expect(transform.getSubject(doc)).to.equal('patient-7');
    });

    it('prefers top-level patient_id over fields.patient_id on a report', () => {
      const doc = {
        type: 'data_record',
        form: 'p',
        patient_id: 'top-level',
        fields: { patient_id: 'in-fields' },
      };
      expect(transform.getSubject(doc)).to.equal('top-level');
    });

    it('falls back to place_id and fields.place_id when no patient ref is set', () => {
      expect(transform.getSubject({ type: 'data_record', form: 'p', place_id: 'place-1' }))
        .to.equal('place-1');
      expect(transform.getSubject({ type: 'data_record', form: 'p', fields: { place_id: 'place-2' } }))
        .to.equal('place-2');
    });

    it('falls back to fields.patient_uuid after patient/place fields are exhausted', () => {
      const doc = {
        type: 'data_record',
        form: 'p',
        fields: { patient_uuid: 'pu-1' },
      };
      expect(transform.getSubject(doc)).to.equal('pu-1');
    });

    it('falls back to contact._id when no patient/place reference exists on a report', () => {
      const doc = { type: 'data_record', form: 'p', contact: { _id: 'submitter-1' } };
      expect(transform.getSubject(doc)).to.equal('submitter-1');
    });

    it('returns _unassigned for a data_record with nothing extractable', () => {
      expect(transform.getSubject({ type: 'data_record', form: 'p' })).to.equal('_unassigned');
    });

    it('returns the registration submitter for reports with patient errors', () => {
      const doc = {
        type: 'data_record',
        form: 'p',
        contact: { _id: 'sender' },
        errors: [{ code: 'registration_not_found' }],
        patient_id: 'unused',
      };
      expect(transform.getSubject(doc)).to.equal('sender');
    });

    it('returns the registration submitter for reports with invalid_patient_id errors', () => {
      const doc = {
        type: 'data_record',
        form: 'p',
        contact: { _id: 'sender' },
        errors: [{ code: 'invalid_patient_id' }],
        patient_id: 'unused',
      };
      expect(transform.getSubject(doc)).to.equal('sender');
    });

    it('ignores unrelated error codes on a report', () => {
      const doc = {
        type: 'data_record',
        form: 'p',
        contact: { _id: 'sender' },
        errors: [{ code: 'something_else' }],
        patient_id: 'real-patient',
      };
      expect(transform.getSubject(doc)).to.equal('real-patient');
    });

    it('returns the message contact for incoming sms_message records', () => {
      const doc = {
        type: 'data_record',
        sms_message: { from: '+1' },
        contact: { _id: 'msg-from' },
      };
      expect(transform.getSubject(doc)).to.equal('msg-from');
    });

    it('returns _unassigned for an sms_message with no contact', () => {
      const doc = { type: 'data_record', sms_message: { from: '+1' } };
      expect(transform.getSubject(doc)).to.equal('_unassigned');
    });

    it('returns the first kujua_message task contact', () => {
      const doc = {
        type: 'data_record',
        kujua_message: true,
        tasks: [{ messages: [{ contact: { _id: 'kujua-c' } }] }],
      };
      expect(transform.getSubject(doc)).to.equal('kujua-c');
    });

    it('returns _unassigned for a kujua_message without a task contact', () => {
      const doc = { type: 'data_record', kujua_message: true };
      expect(transform.getSubject(doc)).to.equal('_unassigned');
    });

    it('returns the user field for task docs', () => {
      expect(transform.getSubject({ type: 'task', user: 'org.couchdb.user:eve' }))
        .to.equal('org.couchdb.user:eve');
    });

    it('returns null for a task doc without a user', () => {
      expect(transform.getSubject({ type: 'task' })).to.equal(null);
    });

    it('returns the owner field for target docs', () => {
      expect(transform.getSubject({ type: 'target', owner: 'contact-77' })).to.equal('contact-77');
    });

    it('returns null for a target doc without an owner', () => {
      expect(transform.getSubject({ type: 'target' })).to.equal(null);
    });

    it('returns null for known system docs', () => {
      expect(transform.getSubject({ _id: 'settings' })).to.equal(null);
      expect(transform.getSubject({ _id: 'resources' })).to.equal(null);
      expect(transform.getSubject({ type: 'translations' })).to.equal(null);
      expect(transform.getSubject({ type: 'form' })).to.equal(null);
    });

    it('returns null for an unknown doc type', () => {
      expect(transform.getSubject({ type: 'mystery' })).to.equal(null);
    });
  });

  describe('getDocType', () => {
    it('returns the type field', () => {
      expect(transform.getDocType({ type: 'data_record' })).to.equal('data_record');
    });

    it('returns null when type is missing or non-string', () => {
      expect(transform.getDocType({})).to.equal(null);
      expect(transform.getDocType({ type: 1 })).to.equal(null);
      expect(transform.getDocType(null)).to.equal(null);
    });
  });
});
