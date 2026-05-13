import { TestBed } from '@angular/core/testing';
import sinon from 'sinon';
import { expect } from 'chai';
import { HttpClient } from '@angular/common/http';
import { of, throwError } from 'rxjs';

import { PgReplicationService } from '@mm-services/pg-replication.service';
import { DbService } from '@mm-services/db.service';
import { RulesEngineService } from '@mm-services/rules-engine.service';

const FLAG_KEY = 'medic-pg-sync-enabled';
const LAST_SEQ_KEY = 'medic-pg-sync-last-seq';
const CUTOVER_KEY = 'medic-pg-sync-cutover-done';

describe('PgReplicationService', () => {
  let service: PgReplicationService;
  let localDb;
  let dbService;
  let http;
  let rulesEngineService;
  let docStore: Map<string, any>;

  /**
   * Minimal in-memory PouchDB-shaped harness. Models the calls our service
   * makes — bulkDocs (with new_edits:false), get, info — well enough to
   * verify the "doc lands and is readable / tombstone makes get reject"
   * contract in PROJECT.md without pulling a real PouchDB into karma.
   */
  const buildLocalDb = () => {
    docStore = new Map();
    let updateSeq = 0;

    return {
      info: sinon.stub().callsFake(() => Promise.resolve({ update_seq: updateSeq })),
      get: sinon.stub().callsFake((id) => {
        const doc = docStore.get(id);
        if (!doc || doc._deleted) {
          const err: any = new Error('missing');
          err.status = 404;
          err.name = 'not_found';
          return Promise.reject(err);
        }
        return Promise.resolve(doc);
      }),
      bulkDocs: sinon.stub().callsFake((docs) => {
        const results: any[] = [];
        docs.forEach((doc) => {
          updateSeq += 1;
          if (doc._deleted) {
            docStore.set(doc._id, { _id: doc._id, _rev: doc._rev, _deleted: true });
          } else {
            docStore.set(doc._id, doc);
          }
          results.push({ ok: true, id: doc._id, rev: doc._rev });
        });
        return Promise.resolve(results);
      }),
      remove: sinon.stub().callsFake((id, rev) => {
        const doc = docStore.get(id);
        if (!doc || doc._deleted) {
          const err: any = new Error('missing');
          err.status = 404;
          return Promise.reject(err);
        }
        updateSeq += 1;
        docStore.set(id, { _id: id, _rev: rev, _deleted: true });
        return Promise.resolve({ ok: true, id, rev });
      }),
    };
  };

  const clearStorage = () => {
    window.localStorage.removeItem(FLAG_KEY);
    window.localStorage.removeItem(LAST_SEQ_KEY);
    window.localStorage.removeItem(CUTOVER_KEY);
  };

  beforeEach(() => {
    clearStorage();

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
    clearStorage();
  });

  describe('isEnabled', () => {
    it('returns false when localStorage flag is unset', () => {
      expect(service.isEnabled()).to.equal(false);
    });

    it('returns true when localStorage flag is "true"', () => {
      window.localStorage.setItem(FLAG_KEY, 'true');
      expect(service.isEnabled()).to.equal(true);
    });

    it('returns false for any non-"true" value', () => {
      window.localStorage.setItem(FLAG_KEY, '1');
      expect(service.isEnabled()).to.equal(false);
      window.localStorage.setItem(FLAG_KEY, 'yes');
      expect(service.isEnabled()).to.equal(false);
    });
  });

  describe('replicateFrom — initial sync', () => {
    it('POSTs since=0 on first run, lands docs locally, persists last_seq, marks cutover', async () => {
      // Cutover endpoint
      http.post.withArgs('/api/v1/pg-sync/cutover').returns(of({ ok: true }));
      // pg-sync endpoint
      const docs = [
        { _id: 'a', _rev: '1-abc', value: 1 },
        { _id: 'b', _rev: '1-def', value: 2 },
      ];
      http.post.withArgs('/api/v1/pg-sync').returns(of({ docs, last_seq: 42 }));

      const result = await service.replicateFrom();

      expect(result).to.deep.equal({ read_docs: 2 });

      // since=0 sent
      const pgCall = http.post.getCalls().find(c => c.args[0] === '/api/v1/pg-sync');
      expect(pgCall.args[1]).to.deep.equal({ since: 0 });
      expect(pgCall.args[2]).to.deep.equal({ responseType: 'json' });

      // bulkDocs received both docs with new_edits:false
      expect(localDb.bulkDocs.args).to.deep.equal([[docs, { new_edits: false }]]);

      // docs are readable via local.get()
      const fetchedA = await localDb.get('a');
      expect(fetchedA).to.deep.include({ _id: 'a', value: 1 });
      const fetchedB = await localDb.get('b');
      expect(fetchedB).to.deep.include({ _id: 'b', value: 2 });

      // last_seq persisted
      expect(window.localStorage.getItem(LAST_SEQ_KEY)).to.equal('42');
      // cutover marked
      expect(window.localStorage.getItem(CUTOVER_KEY)).to.equal('true');

      // rules engine notified about non-deleted docs
      expect(rulesEngineService.monitorExternalChanges.args).to.deep.equal([[{ docs }]]);
    });

    it('records cutover with current PouchDB update_seq on first run only', async () => {
      const cutoverPosts: any[] = [];
      http.post.withArgs('/api/v1/pg-sync/cutover').callsFake((url, body) => {
        cutoverPosts.push(body);
        return of({ ok: true });
      });
      http.post.withArgs('/api/v1/pg-sync').returns(of({ docs: [], last_seq: 5 }));

      // simulate prior pouch state for the cutover seq
      await localDb.bulkDocs([{ _id: 'preexisting', _rev: '1-x', f: 1 }]);

      await service.replicateFrom();

      expect(cutoverPosts).to.have.length(1);
      expect(cutoverPosts[0]).to.deep.equal({ pouchdb_seq: 1 });

      // second sync should NOT re-cutover
      http.post.resetHistory();
      http.post.withArgs('/api/v1/pg-sync/cutover').returns(of({ ok: true }));
      http.post.withArgs('/api/v1/pg-sync').returns(of({ docs: [], last_seq: 9 }));

      await service.replicateFrom();

      const cutoverCalls = http.post.getCalls().filter(c => c.args[0] === '/api/v1/pg-sync/cutover');
      expect(cutoverCalls).to.have.length(0);
    });
  });

  describe('replicateFrom — incremental sync', () => {
    it('sends since equal to previously persisted last_seq and only writes newer docs', async () => {
      // simulate prior successful sync
      window.localStorage.setItem(CUTOVER_KEY, 'true');
      window.localStorage.setItem(LAST_SEQ_KEY, '17');
      // seed an "older" doc as already-present locally; sync should not re-fetch it
      await localDb.bulkDocs([{ _id: 'older', _rev: '1-old', value: 0 }]);
      localDb.bulkDocs.resetHistory();

      const newer = [{ _id: 'new1', _rev: '1-new', value: 99 }];
      http.post.withArgs('/api/v1/pg-sync').returns(of({ docs: newer, last_seq: 25 }));

      const result = await service.replicateFrom();

      expect(result).to.deep.equal({ read_docs: 1 });
      const pgCall = http.post.getCalls().find(c => c.args[0] === '/api/v1/pg-sync');
      expect(pgCall.args[1]).to.deep.equal({ since: 17 });

      // only newer doc was written
      expect(localDb.bulkDocs.args).to.deep.equal([[newer, { new_edits: false }]]);

      // older doc untouched
      const older = await localDb.get('older');
      expect(older).to.deep.include({ _id: 'older', value: 0 });

      // last_seq advanced
      expect(window.localStorage.getItem(LAST_SEQ_KEY)).to.equal('25');
    });

    it('skips bulkDocs entirely when server returns no docs', async () => {
      window.localStorage.setItem(CUTOVER_KEY, 'true');
      window.localStorage.setItem(LAST_SEQ_KEY, '50');
      http.post.withArgs('/api/v1/pg-sync').returns(of({ docs: [], last_seq: 50 }));

      const result = await service.replicateFrom();

      expect(result).to.deep.equal({ read_docs: 0 });
      expect(localDb.bulkDocs.callCount).to.equal(0);
      expect(rulesEngineService.monitorExternalChanges.callCount).to.equal(0);
    });
  });

  describe('replicateFrom — tombstones', () => {
    it('removes deleted docs locally; pouch.get rejects with not-found after', async () => {
      window.localStorage.setItem(CUTOVER_KEY, 'true');
      // seed the doc that the server will tombstone
      await localDb.bulkDocs([{ _id: 'doomed', _rev: '1-aa', value: 1 }]);
      localDb.bulkDocs.resetHistory();

      const tombstone = { _id: 'doomed', _rev: '2-bb', _deleted: true };
      http.post.withArgs('/api/v1/pg-sync').returns(of({ docs: [tombstone], last_seq: 30 }));

      const result = await service.replicateFrom();

      expect(result).to.deep.equal({ read_docs: 1 });
      expect(localDb.bulkDocs.args).to.deep.equal([[[tombstone], { new_edits: false }]]);

      // pouch.get rejects with not_found / status 404
      let caught;
      try {
        await localDb.get('doomed');
      } catch (err) {
        caught = err;
      }
      expect(caught).to.exist;
      expect(caught.status).to.equal(404);

      // rules engine notified only about non-deleted docs
      expect(rulesEngineService.monitorExternalChanges.callCount).to.equal(0);
    });

    it('handles a mix of upserts and tombstones in a single response', async () => {
      window.localStorage.setItem(CUTOVER_KEY, 'true');
      await localDb.bulkDocs([{ _id: 'old', _rev: '1-x', value: 1 }]);
      localDb.bulkDocs.resetHistory();

      const docs = [
        { _id: 'new', _rev: '1-y', value: 2 },
        { _id: 'old', _rev: '2-z', _deleted: true },
      ];
      http.post.withArgs('/api/v1/pg-sync').returns(of({ docs, last_seq: 80 }));

      await service.replicateFrom();

      expect(localDb.bulkDocs.args).to.deep.equal([[docs, { new_edits: false }]]);
      const newDoc = await localDb.get('new');
      expect(newDoc).to.deep.include({ _id: 'new', value: 2 });
      try {
        await localDb.get('old');
        expect.fail('Should reject with 404');
      } catch (err) {
        expect(err.status).to.equal(404);
      }

      expect(rulesEngineService.monitorExternalChanges.args).to.deep.equal([[
        { docs: [docs[0]] }
      ]]);
    });
  });

  describe('replicateFrom — last_seq persistence across restarts', () => {
    it('next sync after a simulated app restart uses the persisted last_seq as since', async () => {
      // first sync
      http.post.withArgs('/api/v1/pg-sync/cutover').returns(of({ ok: true }));
      http.post.withArgs('/api/v1/pg-sync').returns(of({ docs: [], last_seq: 123 }));
      await service.replicateFrom();
      expect(window.localStorage.getItem(LAST_SEQ_KEY)).to.equal('123');

      // simulate restart — fresh TestBed/service, localStorage survives
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          { provide: DbService, useValue: { get: dbService } },
          { provide: HttpClient, useValue: http },
          { provide: RulesEngineService, useValue: rulesEngineService },
        ]
      });
      const freshService = TestBed.inject(PgReplicationService);

      http.post.resetHistory();
      http.post.withArgs('/api/v1/pg-sync').returns(of({ docs: [], last_seq: 200 }));

      await freshService.replicateFrom();

      const pgCall = http.post.getCalls().find(c => c.args[0] === '/api/v1/pg-sync');
      expect(pgCall.args[1]).to.deep.equal({ since: 123 });
    });
  });

  describe('replicateFrom — failure semantics', () => {
    it('does not advance last_seq when the pg-sync HTTP call fails', async () => {
      window.localStorage.setItem(CUTOVER_KEY, 'true');
      window.localStorage.setItem(LAST_SEQ_KEY, '60');
      http.post.withArgs('/api/v1/pg-sync').returns(throwError(() => new Error('network down')));

      let caught;
      try {
        await service.replicateFrom();
      } catch (err) {
        caught = err;
      }
      expect(caught).to.exist;
      expect(caught.message).to.equal('network down');

      // last_seq unchanged
      expect(window.localStorage.getItem(LAST_SEQ_KEY)).to.equal('60');
      // nothing written locally
      expect(localDb.bulkDocs.callCount).to.equal(0);
    });

    it('does not advance last_seq when bulkDocs fails mid-sync', async () => {
      window.localStorage.setItem(CUTOVER_KEY, 'true');
      window.localStorage.setItem(LAST_SEQ_KEY, '60');

      http.post.withArgs('/api/v1/pg-sync').returns(of({
        docs: [{ _id: 'a', _rev: '1-aa', v: 1 }],
        last_seq: 75,
      }));
      localDb.bulkDocs.callsFake(() => Promise.reject(new Error('bulk fail')));

      let caught;
      try {
        await service.replicateFrom();
      } catch (err) {
        caught = err;
      }
      expect(caught).to.exist;
      expect(caught.message).to.equal('bulk fail');

      expect(window.localStorage.getItem(LAST_SEQ_KEY)).to.equal('60');
    });

    it('does not mark cutover done when the cutover POST fails', async () => {
      http.post.withArgs('/api/v1/pg-sync/cutover').returns(throwError(() => new Error('cutover failed')));
      http.post.withArgs('/api/v1/pg-sync').returns(of({ docs: [], last_seq: 1 }));

      let caught;
      try {
        await service.replicateFrom();
      } catch (err) {
        caught = err;
      }
      expect(caught).to.exist;
      expect(caught.message).to.equal('cutover failed');

      expect(window.localStorage.getItem(CUTOVER_KEY)).to.equal(null);
      // pg-sync was not called because cutover threw first
      const pgCall = http.post.getCalls().find(c => c.args[0] === '/api/v1/pg-sync');
      expect(pgCall).to.equal(undefined);
    });
  });
});
