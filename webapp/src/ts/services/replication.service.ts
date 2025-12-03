import { Injectable } from '@angular/core';
import { lastValueFrom } from 'rxjs';
import { DbService } from './db.service';
import { HttpClient } from '@angular/common/http';
import { RulesEngineService } from '@mm-services/rules-engine.service';

@Injectable({
  providedIn: 'root'
})
export class ReplicationService {
  constructor(
    private dbService:DbService,
    private http:HttpClient,
    private rulesEngineService:RulesEngineService,
  ) {
  }

  private readonly BATCH_SIZE=100;
  private readonly READ_ONLY_TYPES = ['form', 'translations'];
  private readonly READ_ONLY_IDS = ['resources', 'branding', 'service-worker-meta', 'zscore-charts', 'settings', 'partners'];

  async replicateFrom(sinceTimestamp?: number):Promise<{ read_docs: number }> {
    const changes = await this.getChanges(sinceTimestamp);
    const localDocs = await this.dbService.get().allDocs();

    const localIdRevMap = Object.assign({}, ...localDocs.rows.map(row => ({ [row.id]: row.value?.rev })));
    const remoteIdRevMap = Object.assign({}, ...changes.map(({ id, rev }) => ({ [id]: rev })));

    const nbrDownloaded = await this.getMissingDocs(localIdRevMap, changes);
    const nbrDeleted = await this.getDeletesAndPurges(localIdRevMap, remoteIdRevMap);
    return { read_docs: nbrDeleted + nbrDownloaded };
  }

  async replicateTo(sinceSeq?: number):Promise<{ docs_written: number, last_seq: number }> {
    // Get local changes since last sync
    const changesResult = await this.dbService.get().changes({
      since: sinceSeq || 0,
      include_docs: true,
      batch_size: this.BATCH_SIZE
    });

    // Filter out purged, read-only, and design docs (same logic as readOnlyFilter)
    const docsToSend = changesResult.results
      .map(change => change.doc)
      .filter(doc => {
        if (!doc) {
          return false;
        }
        // Never replicate "purged" documents upwards
        const keys = Object.keys(doc);
        if (keys.length === 4 &&
            keys.includes('_id') &&
            keys.includes('_rev') &&
            keys.includes('_deleted') &&
            keys.includes('purged')) {
          return false;
        }
        // Never replicate design docs
        if (doc._id.indexOf('_design/') === 0) {
          return false;
        }
        // Don't replicate read-only types and IDs
        if (this.READ_ONLY_TYPES.includes(doc.type)) {
          return false;
        }
        if (this.READ_ONLY_IDS.includes(doc._id)) {
          return false;
        }
        return true;
      });

    if (docsToSend.length === 0) {
      return { docs_written: 0, last_seq: changesResult.last_seq };
    }

    // Send docs to bulk_docs endpoint
    const bulkDocsReq = this.http.post(
      '/medic/_bulk_docs',
      { docs: docsToSend },
      { responseType: 'json' }
    );
    await lastValueFrom(bulkDocsReq);

    return { docs_written: docsToSend.length, last_seq: changesResult.last_seq };
  }

  private async getChanges(sinceTimestamp?: number):Promise<{ id; rev }[]> {
    let url = '/api/v1/replication/changes';
    if (sinceTimestamp) {
      url += `?since=${sinceTimestamp}`;
    }
    const getChangesReq = this.http.get<{ changes: { id; rev }[]}>(
      url,
      { responseType: 'json' }
    );
    const response = await lastValueFrom(getChangesReq);
    return response.changes;
  }

  private async getMissingDocs(localIdRevMap, remoteDocIdsRevs):Promise<number> {
    const docIdRevsToDownload = remoteDocIdsRevs
      .filter(({ id, rev }) => !localIdRevMap[id] || localIdRevMap[id] !== rev);
    const nbrDocs = docIdRevsToDownload.length;

    while (docIdRevsToDownload.length) {
      const batch = docIdRevsToDownload.splice(0, this.BATCH_SIZE);
      await this.downloadDocsBatch(batch);
    }

    return nbrDocs;
  }

  private async getDeletesAndPurges(localIdRevMap, remoteIdRevMap):Promise<number> {
    const missingRemoteIds = Object.keys(localIdRevMap).filter(id => !remoteIdRevMap[id]);
    let nbrDeletes = 0;

    while (missingRemoteIds.length) {
      const batch = missingRemoteIds.splice(0, this.BATCH_SIZE);
      const getDeleteListReq =  this.http.post<{ doc_ids: []}>(
        '/api/v1/replication/get-deletes',
        { doc_ids: batch },
        { responseType: 'json' }
      );
      const localIdsToDelete = (await lastValueFrom(getDeleteListReq)).doc_ids;
      const deleteDocs = localIdsToDelete
        .map(id => ({ _id: id, _rev: localIdRevMap[id], _deleted: true, purged: true }));
      await this.dbService.get().bulkDocs(deleteDocs);
      nbrDeletes += deleteDocs.length;
    }
    return nbrDeletes;
  }

  private async downloadDocsBatch(batch):Promise<void> {
    // Use direct HTTP call instead of PouchDB's bulkGet to avoid CouchDB protocol calls (like dbinfo)
    const bulkGetReq = this.http.post<{ results: { docs: { ok?: any }[] }[] }>(
      '/medic/_bulk_get?attachments=true&revs=true',
      { docs: batch },
      { responseType: 'json' }
    );
    const res = await lastValueFrom(bulkGetReq);

    const docs = res.results
      .map(result => result.docs && result.docs[0] && result.docs[0].ok)
      .filter(doc => doc);
    await this.dbService.get().bulkDocs(docs, { new_edits: false });
    this.rulesEngineService.monitorExternalChanges({ docs });
  }
}
