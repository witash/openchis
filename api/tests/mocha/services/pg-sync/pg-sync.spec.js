const { expect } = require('chai');
const sinon = require('sinon');

const pgPool = require('../../../../src/services/pg-sync/pg-pool');
const pgSync = require('../../../../src/services/pg-sync/pg-sync');

const makeRow = (id, seq, subject, opts = {}) => ({
  doc: Object.assign({ _id: id, _rev: '1-abc' }, opts.docExtra || {}),
  seq,
  deleted: !!opts.deleted,
});

describe('pg-sync service', () => {
  afterEach(() => sinon.restore());

  describe('getDocs', () => {
    it('queries by contact_id and since, returning docs + last_seq', async () => {
      const rows = [
        makeRow('doc-1', '5', 'contact-A'),
        makeRow('doc-2', '7', 'contact-A'),
      ];
      const query = sinon.stub(pgPool, 'query').resolves({ rows });

      const result = await pgSync.getDocs({ contact_id: 'contact-A' }, 3);

      expect(query.callCount).to.equal(1);
      expect(query.args[0][1]).to.deep.equal([3, 'contact-A']);
      expect(result.docs).to.deep.equal([
        { _id: 'doc-1', _rev: '1-abc' },
        { _id: 'doc-2', _rev: '1-abc' },
      ]);
      expect(result.last_seq).to.equal(7);
    });

    it('uses facility_id when contact_id is missing', async () => {
      const q = sinon.stub(pgPool, 'query');
      q.onFirstCall().resolves({ rows: [] });
      q.onSecondCall().resolves({ rows: [{ last_seq: '0' }] });

      const result = await pgSync.getDocs({ facility_id: ['facility-X'] }, 0);

      expect(q.firstCall.args[1]).to.deep.equal([0, 'facility-X']);
      expect(result.docs).to.deep.equal([]);
      expect(result.last_seq).to.equal(0);
    });

    it('SQL filters by since (seq > $1) and by authorization (subject or lineage)', async () => {
      const q = sinon.stub(pgPool, 'query').resolves({ rows: [] });
      q.onSecondCall().resolves({ rows: [{ last_seq: '0' }] });

      await pgSync.getDocs({ contact_id: 'c1' }, 10);

      const sql = q.firstCall.args[0];
      expect(sql).to.match(/seq\s*>\s*\$1/);
      expect(sql).to.match(/subject\s*=\s*\$2/);
      expect(sql).to.match(/\$2\s*=\s*ANY\s*\(\s*c\.lineage\s*\)/);
      expect(sql).to.match(/ORDER BY md\.seq/i);
    });

    it('marks tombstones with _deleted: true', async () => {
      const rows = [
        makeRow('doc-1', '11', 'contact-A', { deleted: true }),
        makeRow('doc-2', '12', 'contact-A'),
      ];
      sinon.stub(pgPool, 'query').resolves({ rows });

      const result = await pgSync.getDocs({ contact_id: 'contact-A' }, 0);

      expect(result.docs[0]).to.deep.equal({
        _id: 'doc-1', _rev: '1-abc', _deleted: true
      });
      expect(result.docs[1]).to.deep.equal({ _id: 'doc-2', _rev: '1-abc' });
      expect(result.last_seq).to.equal(12);
    });

    it('preserves _deleted: true already set in the doc body', async () => {
      const rows = [{
        doc: { _id: 'doc-1', _rev: '2-xyz', _deleted: true },
        seq: '20',
        deleted: true,
      }];
      sinon.stub(pgPool, 'query').resolves({ rows });

      const result = await pgSync.getDocs({ contact_id: 'c' }, 0);

      expect(result.docs).to.deep.equal([
        { _id: 'doc-1', _rev: '2-xyz', _deleted: true },
      ]);
    });

    it('returns last_seq monotonically: never below since when no rows', async () => {
      const q = sinon.stub(pgPool, 'query');
      q.onFirstCall().resolves({ rows: [] });
      q.onSecondCall().resolves({ rows: [{ last_seq: '5' }] });

      const result = await pgSync.getDocs({ contact_id: 'c' }, 42);

      expect(result.docs).to.deep.equal([]);
      // 42 (since) is greater than current max (5), so last_seq stays at 42.
      expect(result.last_seq).to.equal(42);
    });

    it('returns last_seq monotonically: bumps to current max when ahead of since', async () => {
      const q = sinon.stub(pgPool, 'query');
      q.onFirstCall().resolves({ rows: [] });
      q.onSecondCall().resolves({ rows: [{ last_seq: '99' }] });

      const result = await pgSync.getDocs({ contact_id: 'c' }, 10);

      expect(result.last_seq).to.equal(99);
    });

    it('returns empty docs and current max seq when user has no contact_id/facility_id', async () => {
      const q = sinon.stub(pgPool, 'query');
      q.resolves({ rows: [{ last_seq: '17' }] });

      const result = await pgSync.getDocs({ name: 'nobody' }, 0);

      expect(result.docs).to.deep.equal([]);
      expect(result.last_seq).to.equal(17);
      // No row-selection query was issued — only the max-seq query.
      expect(q.callCount).to.equal(1);
      expect(q.firstCall.args[0]).to.match(/MAX\(seq\)/);
    });

    it('treats negative or invalid `since` as 0', async () => {
      const q = sinon.stub(pgPool, 'query');
      q.onFirstCall().resolves({ rows: [] });
      q.onSecondCall().resolves({ rows: [{ last_seq: '0' }] });

      await pgSync.getDocs({ contact_id: 'c' }, -5);
      expect(q.firstCall.args[1]).to.deep.equal([0, 'c']);

      q.resetHistory();
      q.onFirstCall().resolves({ rows: [] });
      q.onSecondCall().resolves({ rows: [{ last_seq: '0' }] });

      await pgSync.getDocs({ contact_id: 'c' }, 'not a number');
      expect(q.firstCall.args[1]).to.deep.equal([0, 'c']);
    });

    it('does authorize an in-lineage doc and excludes out-of-lineage docs', async () => {
      // The SQL is the authorization mechanism. We assert the mock receives the
      // expected predicates and only returns docs that match, so two contact
      // IDs are distinguished by the parameters passed.
      const allRows = {
        'user-A': [
          makeRow('lin-1', '1', 'descendant-of-A'),
          makeRow('sub-1', '2', 'user-A'),
        ],
        'user-B': [
          makeRow('lin-2', '3', 'descendant-of-B'),
        ],
      };
      sinon.stub(pgPool, 'query').callsFake((sql, params) => {
        if (sql.includes('MAX(seq)')) {
          return Promise.resolve({ rows: [{ last_seq: '0' }] });
        }
        const [, contactId] = params;
        return Promise.resolve({ rows: allRows[contactId] || [] });
      });

      const a = await pgSync.getDocs({ contact_id: 'user-A' }, 0);
      const b = await pgSync.getDocs({ contact_id: 'user-B' }, 0);

      expect(a.docs.map(d => d._id)).to.deep.equal(['lin-1', 'sub-1']);
      expect(b.docs.map(d => d._id)).to.deep.equal(['lin-2']);
      // last_seq matches the last row's seq for each user
      expect(a.last_seq).to.equal(2);
      expect(b.last_seq).to.equal(3);
    });
  });
});
