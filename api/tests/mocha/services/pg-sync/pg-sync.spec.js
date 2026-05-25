const { expect } = require('chai');
const sinon = require('sinon');

const pgPool = require('../../../../src/services/pg-sync/pg-pool');
const pgSync = require('../../../../src/services/pg-sync/pg-sync');

const makeRow = (id, opts = {}) => ({
  doc: Object.assign({ _id: id, _rev: '1-abc' }, opts.docExtra || {}),
  deleted: !!opts.deleted,
});

describe('pg-sync service', () => {
  afterEach(() => sinon.restore());

  describe('getDocs', () => {
    it('queries by user place and returns the authorized doc set', async () => {
      const rows = [makeRow('doc-1'), makeRow('doc-2')];
      const query = sinon.stub(pgPool, 'query').resolves({ rows });

      const result = await pgSync.getDocs({ facility_id: 'place-A', name: 'alice' });

      expect(query.callCount).to.equal(1);
      expect(query.args[0][1]).to.deep.equal(['place-A', 'org.couchdb.user:alice']);
      expect(result).to.deep.equal({
        docs: [
          { _id: 'doc-1', _rev: '1-abc' },
          { _id: 'doc-2', _rev: '1-abc' },
        ],
      });
    });

    it('uses the first element of facility_id when it is an array', async () => {
      const q = sinon.stub(pgPool, 'query').resolves({ rows: [] });
      await pgSync.getDocs({ facility_id: ['place-X'], name: 'bob' });
      expect(q.firstCall.args[1]).to.deep.equal(['place-X', 'org.couchdb.user:bob']);
    });

    it('falls back to contact_id when facility_id is missing', async () => {
      const q = sinon.stub(pgPool, 'query').resolves({ rows: [] });
      await pgSync.getDocs({ contact_id: 'contact-A', name: 'eve' });
      expect(q.firstCall.args[1]).to.deep.equal(['contact-A', 'org.couchdb.user:eve']);
    });

    it('SQL authorizes by subject, lineage, _all, and user-settings id', async () => {
      const q = sinon.stub(pgPool, 'query').resolves({ rows: [] });
      await pgSync.getDocs({ facility_id: 'p', name: 'a' });
      const sql = q.firstCall.args[0];
      expect(sql).to.match(/subject\s*=\s*\$1/);
      expect(sql).to.match(/\$1\s*=\s*ANY\s*\(\s*c\.lineage\s*\)/);
      expect(sql).to.match(/subject\s*=\s*'_all'/);
      expect(sql).to.match(/subject\s*=\s*\$2/);
    });

    it('marks tombstones with _deleted: true', async () => {
      const rows = [
        makeRow('doc-1', { deleted: true }),
        makeRow('doc-2'),
      ];
      sinon.stub(pgPool, 'query').resolves({ rows });

      const result = await pgSync.getDocs({ facility_id: 'p', name: 'a' });

      expect(result.docs[0]).to.deep.equal({ _id: 'doc-1', _rev: '1-abc', _deleted: true });
      expect(result.docs[1]).to.deep.equal({ _id: 'doc-2', _rev: '1-abc' });
    });

    it('preserves _deleted: true already set in the doc body', async () => {
      const rows = [{
        doc: { _id: 'doc-1', _rev: '2-xyz', _deleted: true },
        deleted: true,
      }];
      sinon.stub(pgPool, 'query').resolves({ rows });

      const result = await pgSync.getDocs({ facility_id: 'p', name: 'a' });

      expect(result.docs).to.deep.equal([
        { _id: 'doc-1', _rev: '2-xyz', _deleted: true },
      ]);
    });

    it('returns empty docs and issues no query when user has no place', async () => {
      const q = sinon.stub(pgPool, 'query');
      const result = await pgSync.getDocs({ name: 'nobody' });
      expect(result).to.deep.equal({ docs: [] });
      expect(q.callCount).to.equal(0);
    });
  });
});
