const sinon = require('sinon');

const importer = require('../../../../src/lib/postgres-sync/importer');

const containsSubstr = (substr) => sinon.match((value) => typeof value === 'string' && value.includes(substr));
const matchBegin = () => sinon.match.string.and(sinon.match((v) => v === 'BEGIN'));
const matchCommit = () => sinon.match.string.and(sinon.match((v) => v === 'COMMIT'));
const matchRollback = () => sinon.match.string.and(sinon.match((v) => v === 'ROLLBACK'));
const matchSelectProgress = () => containsSubstr('SELECT seq FROM couch2pg_progress');
const matchUpsertProgress = () => containsSubstr('INSERT INTO couch2pg_progress');
const matchInsertDoc = () => containsSubstr('INSERT INTO documents');
const matchUpdateSubject = () => containsSubstr('UPDATE documents');
const matchSelectContact = () => containsSubstr('SELECT id, parent, lineage FROM contacts');
const matchSelectDescendants = () => containsSubstr('= ANY(lineage)');
const matchUpsertContact = () => containsSubstr('INSERT INTO contacts');
const matchUpdateLineage = () => containsSubstr('UPDATE contacts SET lineage');
const matchDeleteContact = () => containsSubstr('DELETE FROM contacts');

const makeClient = () => {
  const query = sinon.stub().resolves({ rows: [] });
  return {
    query,
    release: sinon.stub(),
  };
};

const makePool = (client) => ({
  connect: sinon.stub().resolves(client),
});

describe('postgres-sync importer', () => {
  let client;
  let pool;

  beforeEach(() => {
    client = makeClient();
    pool = makePool(client);
  });

  afterEach(() => sinon.restore());

  describe('processBatch — transactional boundaries', () => {
    it('wraps the batch in BEGIN ... COMMIT', async () => {
      await importer.processBatch(pool, 'host/db', { results: [], last_seq: 0 });

      expect(client.query.withArgs(matchBegin()).callCount).to.equal(1);
      expect(client.query.withArgs(matchCommit()).callCount).to.equal(1);
      expect(client.query.withArgs(matchRollback()).callCount).to.equal(0);
      expect(client.release.callCount).to.equal(1);
    });

    it('rolls back and rethrows on query failure mid-batch', async () => {
      client.query.withArgs(matchInsertDoc()).rejects(new Error('disk full'));

      await expect(
        importer.processBatch(pool, 'host/db', {
          results: [{ id: 'd1', doc: { _id: 'd1', _rev: '1-a', type: 'data_record' } }],
          last_seq: 5,
        })
      ).to.eventually.be.rejectedWith('disk full');

      expect(client.query.withArgs(matchRollback()).callCount).to.equal(1);
      expect(client.query.withArgs(matchCommit()).callCount).to.equal(0);
      expect(client.query.withArgs(matchUpsertProgress()).callCount).to.equal(0);
      expect(client.release.callCount).to.equal(1);
    });

    it('swallows a failing ROLLBACK and still propagates the original error', async () => {
      client.query.withArgs(matchInsertDoc()).rejects(new Error('disk full'));
      client.query.withArgs(matchRollback()).rejects(new Error('connection dead'));

      await expect(
        importer.processBatch(pool, 'host/db', {
          results: [{ id: 'd1', doc: { _id: 'd1', _rev: '1-a', type: 'data_record' } }],
          last_seq: 5,
        })
      ).to.eventually.be.rejectedWith('disk full');
      expect(client.release.callCount).to.equal(1);
    });

    it('persists last_seq once at the end of the batch', async () => {
      await importer.processBatch(pool, 'host/db', {
        results: [
          { id: 'd1', doc: { _id: 'd1', _rev: '1-a', type: 'data_record' } },
          { id: 'd2', doc: { _id: 'd2', _rev: '1-b', type: 'data_record' } },
        ],
        last_seq: '42-abc',
      });

      const upserts = client.query.withArgs(matchUpsertProgress());
      expect(upserts.callCount).to.equal(1);
      expect(upserts.firstCall.args[1]).to.deep.equal(['host/db', '42-abc']);
    });

    it('does not upsert progress when last_seq is missing', async () => {
      await importer.processBatch(pool, 'host/db', { results: [] });

      expect(client.query.withArgs(matchUpsertProgress()).callCount).to.equal(0);
    });

    it('coerces a null seq via saveProgress to the string "0"', async () => {
      await importer.saveProgress(client, 'host/db', null);
      const call = client.query.withArgs(matchUpsertProgress()).firstCall;
      expect(call.args[1]).to.deep.equal(['host/db', '0']);
    });
  });

  describe('processBatch — new doc insert', () => {
    it('writes a non-contact doc with extracted subject and type', async () => {
      const change = {
        id: 'report-1',
        seq: 5,
        doc: {
          _id: 'report-1',
          _rev: '1-abc',
          type: 'data_record',
          form: 'pregnancy',
          fields: { patient_id: 'patient-9' },
        },
      };

      await importer.processBatch(pool, 'host/db', { results: [change], last_seq: 5 });

      const insertCall = client.query.withArgs(matchInsertDoc()).firstCall;
      expect(insertCall).to.exist;
      expect(insertCall.args[1]).to.deep.equal([
        'report-1',
        '1-abc',
        JSON.stringify(change.doc),
        'patient-9',
        'data_record',
        false,
      ]);

      // No contact-table writes for a non-contact doc.
      expect(client.query.withArgs(matchUpsertContact()).callCount).to.equal(0);
      expect(client.query.withArgs(matchUpdateLineage()).callCount).to.equal(0);
    });

    it('inserts a contact doc and upserts the contacts row with a derived lineage', async () => {
      const change = {
        id: 'clinic-1',
        seq: 10,
        doc: {
          _id: 'clinic-1',
          _rev: '1-aa',
          type: 'clinic',
          name: 'East Clinic',
          parent: { _id: 'district-1' },
          phone: '+1234567890',
        },
      };
      // The parent contact already exists with lineage [].
      client.query
        .withArgs(matchSelectContact(), ['district-1'])
        .resolves({ rows: [{ id: 'district-1', parent: null, lineage: [] }] });
      // This contact itself does not exist yet.
      client.query
        .withArgs(matchSelectContact(), ['clinic-1'])
        .resolves({ rows: [] });

      await importer.processBatch(pool, 'host/db', { results: [change], last_seq: 10 });

      const insertDoc = client.query.withArgs(matchInsertDoc()).firstCall;
      expect(insertDoc.args[1]).to.deep.equal([
        'clinic-1',
        '1-aa',
        JSON.stringify(change.doc),
        'clinic-1', // subject for contact docs is the doc id itself
        'clinic',
        false,
      ]);

      const upsertContact = client.query.withArgs(matchUpsertContact()).firstCall;
      expect(upsertContact).to.exist;
      expect(upsertContact.args[1]).to.deep.equal([
        'clinic-1',
        'clinic',
        'clinic',
        'district-1',
        ['district-1'], // parent id + parent's lineage []
        'East Clinic',
        null,
        '+1234567890',
        null,
      ]);

      // First-time insert: no cascade.
      expect(client.query.withArgs(matchUpdateLineage()).callCount).to.equal(0);
    });

    it('falls back to a single-id lineage when the parent is not yet known', async () => {
      const change = {
        id: 'orphan-1',
        seq: 11,
        doc: {
          _id: 'orphan-1',
          _rev: '1-z',
          type: 'person',
          parent: { _id: 'future-parent' },
        },
      };
      client.query
        .withArgs(matchSelectContact(), ['future-parent'])
        .resolves({ rows: [] });
      client.query
        .withArgs(matchSelectContact(), ['orphan-1'])
        .resolves({ rows: [] });

      await importer.processBatch(pool, 'host/db', { results: [change], last_seq: 11 });

      const upsertContact = client.query.withArgs(matchUpsertContact()).firstCall;
      expect(upsertContact.args[1][4]).to.deep.equal(['future-parent']);
    });

    it('writes an empty lineage when the contact has no parent', async () => {
      const change = {
        id: 'root-1',
        seq: 12,
        doc: { _id: 'root-1', _rev: '1-r', type: 'district_hospital' },
      };
      client.query
        .withArgs(matchSelectContact(), ['root-1'])
        .resolves({ rows: [] });

      await importer.processBatch(pool, 'host/db', { results: [change], last_seq: 12 });

      const upsertContact = client.query.withArgs(matchUpsertContact()).firstCall;
      expect(upsertContact.args[1][3]).to.equal(null); // parent
      expect(upsertContact.args[1][4]).to.deep.equal([]); // lineage
    });

    it('stamps muted as a Date when present', async () => {
      const mutedAt = '2024-05-01T12:00:00Z';
      const change = {
        id: 'p1',
        seq: 13,
        doc: { _id: 'p1', _rev: '1', type: 'person', muted: mutedAt },
      };
      client.query.withArgs(matchSelectContact(), ['p1']).resolves({ rows: [] });

      await importer.processBatch(pool, 'host/db', { results: [change], last_seq: 13 });

      const upsertContact = client.query.withArgs(matchUpsertContact()).firstCall;
      expect(upsertContact.args[1][6]).to.be.instanceOf(Date);
      expect(upsertContact.args[1][6].toISOString()).to.equal('2024-05-01T12:00:00.000Z');
    });
  });

  describe('processBatch — doc update (new _rev)', () => {
    it('inserts a second row when the same _id arrives with a new _rev', async () => {
      const v1 = {
        id: 'report-1',
        seq: 5,
        doc: { _id: 'report-1', _rev: '1-abc', type: 'data_record', form: 'a' },
      };
      const v2 = {
        id: 'report-1',
        seq: 6,
        doc: { _id: 'report-1', _rev: '2-def', type: 'data_record', form: 'b' },
      };

      await importer.processBatch(pool, 'host/db', { results: [v1, v2], last_seq: 6 });

      const inserts = client.query.withArgs(matchInsertDoc());
      expect(inserts.callCount).to.equal(2);
      expect(inserts.firstCall.args[1][0]).to.equal('report-1');
      expect(inserts.firstCall.args[1][1]).to.equal('1-abc');
      expect(inserts.secondCall.args[1][0]).to.equal('report-1');
      expect(inserts.secondCall.args[1][1]).to.equal('2-def');
      expect(inserts.secondCall.args[1][2]).to.equal(JSON.stringify(v2.doc));
    });
  });

  describe('processBatch — soft delete', () => {
    it('writes a tombstone with deleted=true and removes any contact row', async () => {
      const change = {
        id: 'doc-1',
        seq: 7,
        deleted: true,
        changes: [{ rev: '3-tomb' }],
      };

      await importer.processBatch(pool, 'host/db', { results: [change], last_seq: 7 });

      const insertCall = client.query.withArgs(matchInsertDoc()).firstCall;
      expect(insertCall.args[1][0]).to.equal('doc-1');
      expect(insertCall.args[1][1]).to.equal('3-tomb');
      expect(JSON.parse(insertCall.args[1][2])).to.deep.equal({
        _id: 'doc-1',
        _rev: '3-tomb',
        _deleted: true,
      });
      expect(insertCall.args[1][3]).to.equal(null); // subject
      expect(insertCall.args[1][4]).to.equal(null); // type
      expect(insertCall.args[1][5]).to.equal(true); // deleted

      const deleteContact = client.query.withArgs(matchDeleteContact()).firstCall;
      expect(deleteContact).to.exist;
      expect(deleteContact.args[1]).to.deep.equal(['doc-1']);
    });

    it('uses doc._rev as the tombstone rev when changes[] is missing', async () => {
      const change = {
        id: 'doc-1',
        seq: 7,
        deleted: true,
        doc: { _id: 'doc-1', _rev: '3-via-doc' },
      };

      await importer.processBatch(pool, 'host/db', { results: [change], last_seq: 7 });

      const insertCall = client.query.withArgs(matchInsertDoc()).firstCall;
      expect(insertCall.args[1][1]).to.equal('3-via-doc');
    });

    it('falls back to a zero rev when neither changes[] nor doc._rev are present', async () => {
      const change = { id: 'doc-1', deleted: true };

      await importer.processBatch(pool, 'host/db', { results: [change], last_seq: 7 });

      const insertCall = client.query.withArgs(matchInsertDoc()).firstCall;
      expect(insertCall.args[1][1]).to.equal('0');
    });

    it('does not look up the contact table for a deletion', async () => {
      const change = { id: 'doc-1', seq: 7, deleted: true, changes: [{ rev: '3' }] };

      await importer.processBatch(pool, 'host/db', { results: [change], last_seq: 7 });

      // We may still query the progress/transaction control rows, but never
      // SELECT from contacts for a tombstone.
      expect(client.query.withArgs(matchSelectContact()).callCount).to.equal(0);
    });
  });

  describe('processBatch — malformed change handling', () => {
    it('silently skips changes without an id', async () => {
      const result = await importer.processBatch(pool, 'host/db', {
        results: [{ seq: 1, doc: { _rev: '1-a' } }],
        last_seq: 1,
      });

      expect(result.results[0]).to.deep.equal({ skipped: true, reason: 'malformed' });
      expect(client.query.withArgs(matchInsertDoc()).callCount).to.equal(0);
      // Progress is still advanced so we don't re-process the malformed entry.
      expect(client.query.withArgs(matchUpsertProgress()).callCount).to.equal(1);
    });

    it('silently skips non-deleted changes without a doc body', async () => {
      const result = await importer.processBatch(pool, 'host/db', {
        results: [{ id: 'lost', seq: 1 }],
        last_seq: 1,
      });

      expect(result.results[0]).to.deep.equal({ skipped: true, reason: 'malformed' });
      expect(client.query.withArgs(matchInsertDoc()).callCount).to.equal(0);
    });

    it('silently skips changes whose doc is missing _id or _rev', async () => {
      const result = await importer.processBatch(pool, 'host/db', {
        results: [
          { id: 'x', doc: { _id: 'x' } }, // missing _rev
          { id: 'y', doc: { _rev: '1-y' } }, // missing _id
          { id: 'z', doc: null }, // not an object
        ],
        last_seq: 3,
      });

      expect(result.results.every((r) => r.skipped)).to.equal(true);
      expect(client.query.withArgs(matchInsertDoc()).callCount).to.equal(0);
    });

    it('continues processing valid changes after a malformed one', async () => {
      await importer.processBatch(pool, 'host/db', {
        results: [
          { id: 'malformed' }, // skipped
          { id: 'd2', doc: { _id: 'd2', _rev: '1-b', type: 'data_record' } },
        ],
        last_seq: 9,
      });

      expect(client.query.withArgs(matchInsertDoc()).callCount).to.equal(1);
      expect(client.query.withArgs(matchInsertDoc()).firstCall.args[1][0]).to.equal('d2');
      expect(client.query.withArgs(matchCommit()).callCount).to.equal(1);
    });
  });

  describe('processBatch — hierarchy move cascade', () => {
    it('cascades lineage to descendants when a contact reparents', async () => {
      const change = {
        id: 'B',
        seq: 50,
        doc: {
          _id: 'B',
          _rev: '5-move',
          type: 'health_center',
          parent: { _id: 'A2' },
        },
      };

      client.query.withArgs(matchSelectContact(), ['A2'])
        .resolves({ rows: [{ id: 'A2', parent: null, lineage: [] }] });
      client.query.withArgs(matchSelectContact(), ['B'])
        .resolves({ rows: [{ id: 'B', parent: 'A', lineage: ['A'] }] });
      client.query.withArgs(matchSelectDescendants(), ['B'])
        .resolves({ rows: [{ id: 'C', lineage: ['B', 'A'] }] });

      await importer.processBatch(pool, 'host/db', { results: [change], last_seq: 50 });

      const upsertCall = client.query.withArgs(matchUpsertContact()).firstCall;
      expect(upsertCall.args[1][4]).to.deep.equal(['A2']);

      const updateCall = client.query.withArgs(matchUpdateLineage()).firstCall;
      expect(updateCall).to.exist;
      expect(updateCall.args[1]).to.deep.equal([['B', 'A2'], 'C']);
    });

    it('updates deep descendants correctly when an intermediate contact moves', async () => {
      const change = {
        id: 'B',
        seq: 51,
        doc: { _id: 'B', _rev: '6-move', type: 'health_center', parent: { _id: 'A2' } },
      };

      client.query.withArgs(matchSelectContact(), ['A2'])
        .resolves({ rows: [{ id: 'A2', parent: null, lineage: [] }] });
      client.query.withArgs(matchSelectContact(), ['B'])
        .resolves({ rows: [{ id: 'B', parent: 'A', lineage: ['A'] }] });
      client.query.withArgs(matchSelectDescendants(), ['B']).resolves({
        rows: [
          { id: 'C', lineage: ['B', 'A'] },
          { id: 'D', lineage: ['C', 'B', 'A'] },
        ],
      });

      await importer.processBatch(pool, 'host/db', { results: [change], last_seq: 51 });

      const updates = client.query.withArgs(matchUpdateLineage()).getCalls();
      expect(updates.length).to.equal(2);

      const byId = Object.fromEntries(updates.map((c) => [c.args[1][1], c.args[1][0]]));
      expect(byId.C).to.deep.equal(['B', 'A2']);
      expect(byId.D).to.deep.equal(['C', 'B', 'A2']);
    });

    it('does not cascade when the lineage did not change', async () => {
      const change = {
        id: 'B',
        seq: 52,
        doc: { _id: 'B', _rev: '7-stay', type: 'health_center', parent: { _id: 'A' } },
      };

      client.query.withArgs(matchSelectContact(), ['A'])
        .resolves({ rows: [{ id: 'A', parent: null, lineage: [] }] });
      client.query.withArgs(matchSelectContact(), ['B'])
        .resolves({ rows: [{ id: 'B', parent: 'A', lineage: ['A'] }] });

      await importer.processBatch(pool, 'host/db', { results: [change], last_seq: 52 });

      expect(client.query.withArgs(matchSelectDescendants()).callCount).to.equal(0);
      expect(client.query.withArgs(matchUpdateLineage()).callCount).to.equal(0);
      expect(client.query.withArgs(matchUpdateSubject()).callCount).to.equal(0);
    });

    it('skips descendants whose lineage no longer contains the pivot', async () => {
      const change = {
        id: 'B',
        seq: 53,
        doc: { _id: 'B', _rev: '8-move', type: 'health_center', parent: { _id: 'A2' } },
      };

      client.query.withArgs(matchSelectContact(), ['A2'])
        .resolves({ rows: [{ id: 'A2', parent: null, lineage: [] }] });
      client.query.withArgs(matchSelectContact(), ['B'])
        .resolves({ rows: [{ id: 'B', parent: 'A', lineage: ['A'] }] });
      // A descendant row whose lineage no longer mentions B should be left alone.
      client.query.withArgs(matchSelectDescendants(), ['B']).resolves({
        rows: [{ id: 'stale', lineage: ['Z'] }],
      });

      await importer.processBatch(pool, 'host/db', { results: [change], last_seq: 53 });

      expect(client.query.withArgs(matchUpdateLineage()).callCount).to.equal(0);
    });
  });

  describe('getProgress / saveProgress — resume after restart', () => {
    it('returns 0 when there is no persisted progress yet', async () => {
      client.query.withArgs(matchSelectProgress()).resolves({ rows: [] });
      const seq = await importer.getProgress(client, 'host/db');
      expect(seq).to.equal(0);
    });

    it('returns the persisted seq value', async () => {
      client.query.withArgs(matchSelectProgress())
        .resolves({ rows: [{ seq: '128-resume' }] });
      const seq = await importer.getProgress(client, 'host/db');
      expect(seq).to.equal('128-resume');
    });

    it('persists the seq via upsert on the progress table', async () => {
      await importer.saveProgress(client, 'host/db', '42-x');
      const call = client.query.withArgs(matchUpsertProgress()).firstCall;
      expect(call.args[1]).to.deep.equal(['host/db', '42-x']);
    });

    it('resumes from the persisted seq across a simulated restart', async () => {
      await importer.processBatch(pool, 'host/db', {
        results: [{ id: 'd1', doc: { _id: 'd1', _rev: '1-a', type: 'data_record' } }],
        last_seq: '100-x',
      });
      const firstUpsert = client.query.withArgs(matchUpsertProgress()).firstCall;
      expect(firstUpsert.args[1]).to.deep.equal(['host/db', '100-x']);

      const restartedClient = makeClient();
      restartedClient.query.withArgs(matchSelectProgress())
        .resolves({ rows: [{ seq: '100-x' }] });
      const restartedPool = makePool(restartedClient);

      const bootstrapClient = await restartedPool.connect();
      const since = await importer.getProgress(bootstrapClient, 'host/db');
      expect(since).to.equal('100-x');
    });
  });

  describe('computeLineageForParent', () => {
    it('returns an empty lineage for a missing parent id', async () => {
      expect(await importer.computeLineageForParent(client, null)).to.deep.equal([]);
      expect(await importer.computeLineageForParent(client, undefined)).to.deep.equal([]);
    });
  });

  describe('sanitize', () => {
    it('strips literal U+0000 characters', () => {
      const dirty = 'hel' + String.fromCharCode(0) + 'lo';
      expect(importer.sanitize(dirty)).to.equal('hello');
    });

    it('strips escaped \\u0000 sequences', () => {
      const dirty = 'good\\u0000bad';
      expect(importer.sanitize(dirty)).to.equal('goodbad');
    });

    it('returns undefined for undefined input', () => {
      expect(importer.sanitize(undefined)).to.equal(undefined);
    });
  });

  describe('isMalformed', () => {
    it('flags null/undefined changes', () => {
      expect(importer.isMalformed(null)).to.equal(true);
      expect(importer.isMalformed(undefined)).to.equal(true);
    });

    it('flags changes without a string id', () => {
      expect(importer.isMalformed({ doc: { _id: 'x', _rev: '1' } })).to.equal(true);
      expect(importer.isMalformed({ id: 123, doc: { _id: 'x', _rev: '1' } })).to.equal(true);
    });

    it('does not flag well-formed tombstones', () => {
      expect(importer.isMalformed({ id: 'x', deleted: true })).to.equal(false);
    });

    it('flags non-deleted changes without a doc body', () => {
      expect(importer.isMalformed({ id: 'x' })).to.equal(true);
      expect(importer.isMalformed({ id: 'x', doc: null })).to.equal(true);
    });

    it('flags docs missing _id or _rev', () => {
      expect(importer.isMalformed({ id: 'x', doc: { _id: 'x' } })).to.equal(true);
      expect(importer.isMalformed({ id: 'x', doc: { _rev: '1' } })).to.equal(true);
    });

    it('accepts a well-formed change', () => {
      expect(importer.isMalformed({ id: 'x', doc: { _id: 'x', _rev: '1' } })).to.equal(false);
    });
  });
});
