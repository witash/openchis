import { TestBed } from '@angular/core/testing';
import sinon from 'sinon';
import { expect } from 'chai';
import { HttpClient } from '@angular/common/http';
import { of, throwError } from 'rxjs';

import { PgReplicationService } from '@mm-services/pg-replication.service';
import { DbService } from '@mm-services/db.service';
import { RulesEngineService } from '@mm-services/rules-engine.service';

describe('PgReplicationService', () => {
  let service: PgReplicationService;
  let localDb;
  let dbService;
  let http;
  let rulesEngineService;
  let docStore: Map<string, any>;

  const buildLocalDb = () => {
    docStore = new Map();

    return {
      get: sinon.stub().callsFake((id) => {
        const doc = docStore.get(id);
        if (!doc || doc._deleted) {
          const err: any = new Error('missing');
          err.status = 404;
          err.name = 'not_found';
          return Promise.reject(err);
        }
        return Promise.resolve({ ...doc });
      }),
      bulkDocs: sinon.stub().callsFake((docs) => {
        const results: any[] = [];
        docs.forEach((doc) => {
          if (doc._deleted) {
            docStore.set(doc._id, { _id: doc._id, _rev: doc._rev, _deleted: true });
          } else {
            docStore.set(doc._id, doc);
          }
          results.push({ ok: true, id: doc._id, rev: doc._rev });
        });
        return Promise.resolve(results);
      }),
    };
  };

  beforeEach(() => {
    http = {
      get: sinon.stub(),
      post: sinon.stub(),
    };
    localDb = buildLocalDb();
    rulesEngineService = { monitorExternalChanges: sinon.stub() };

    dbService = sinon.stub();
    dbService.withArgs().returns(localDb);

    TestBed.configureTestingModule({
      providers: [
        { provide: DbService, useValue: { get: dbService } },
        { provide: HttpClient, useValue: http },
        { provide: RulesEngineService, useValue: rulesEngineService },
      ]
    });

    service = TestBed.inject(PgReplicationService);
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('replicateFrom', () => {
    it('POSTs to /api/v1/pg-sync, lands docs locally, returns read_docs count', async () => {
      const docs = [
        { _id: 'a', _rev: '1-abc', value: 1 },
        { _id: 'b', _rev: '1-def', value: 2 },
      ];
      http.post.withArgs('/api/v1/pg-sync').returns(of({ docs }));

      const result = await service.replicateFrom();

      expect(result).to.deep.equal({ read_docs: 2 });

      const pgCall = http.post.getCalls().find(c => c.args[0] === '/api/v1/pg-sync');
      expect(pgCall.args[1]).to.deep.equal({});
      expect(pgCall.args[2]).to.deep.equal({ responseType: 'json' });

      expect(localDb.bulkDocs.args).to.deep.equal([[docs, { new_edits: false }]]);

      const fetchedA = await localDb.get('a');
      expect(fetchedA).to.deep.include({ _id: 'a', value: 1 });

      expect(rulesEngineService.monitorExternalChanges.args).to.deep.equal([[{ docs }]]);
    });

    it('skips bulkDocs entirely when server returns no docs', async () => {
      http.post.withArgs('/api/v1/pg-sync').returns(of({ docs: [] }));

      const result = await service.replicateFrom();

      expect(result).to.deep.equal({ read_docs: 0 });
      expect(localDb.bulkDocs.callCount).to.equal(0);
      expect(rulesEngineService.monitorExternalChanges.callCount).to.equal(0);
    });

    it('applies tombstones; pouch.get rejects with 404 after', async () => {
      await localDb.bulkDocs([{ _id: 'doomed', _rev: '1-aa', value: 1 }]);
      localDb.bulkDocs.resetHistory();

      const tombstone = { _id: 'doomed', _rev: '2-bb', _deleted: true };
      http.post.withArgs('/api/v1/pg-sync').returns(of({ docs: [tombstone] }));

      await service.replicateFrom();

      expect(localDb.bulkDocs.args).to.deep.equal([[[tombstone], { new_edits: false }]]);

      let caught;
      try {
        await localDb.get('doomed');
      } catch (err) {
        caught = err;
      }
      expect(caught).to.exist;
      expect(caught.status).to.equal(404);

      expect(rulesEngineService.monitorExternalChanges.callCount).to.equal(0);
    });

    it('mixed upserts + tombstones notify rules engine only for upserts', async () => {
      const docs = [
        { _id: 'new', _rev: '1-y', value: 2 },
        { _id: 'old', _rev: '2-z', _deleted: true },
      ];
      http.post.withArgs('/api/v1/pg-sync').returns(of({ docs }));

      await service.replicateFrom();

      expect(rulesEngineService.monitorExternalChanges.args).to.deep.equal([[
        { docs: [docs[0]] }
      ]]);
    });

    it('propagates network errors from the pg-sync HTTP call', async () => {
      http.post.withArgs('/api/v1/pg-sync').returns(throwError(() => new Error('network down')));

      let caught;
      try {
        await service.replicateFrom();
      } catch (err) {
        caught = err;
      }
      expect(caught).to.exist;
      expect(caught.message).to.equal('network down');
      expect(localDb.bulkDocs.callCount).to.equal(0);
    });
  });
});
