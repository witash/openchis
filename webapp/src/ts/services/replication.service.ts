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

  async replicateFrom(sinceSeq?: number):Promise<{ read_docs: number, last_seq?: number }> {
    let totalSaved = 0;
    let currentSeq = sinceSeq;

    while (true) {
      const { docs, last_seq } = await this.getChanges(currentSeq);

      if (docs.length === 0) {
        break;
      }

      // Get local docs to filter out ones we already have with same rev
      const localDocs = await this.dbService.get().allDocs();
      const localIdRevMap = Object.assign({}, ...localDocs.rows.map(row => ({ [row.id]: row.value?.rev })));

      // Filter to only docs we don't have or have different rev
      const docsToSave = docs.filter(doc => !localIdRevMap[doc._id] || localIdRevMap[doc._id] !== doc._rev);

      if (docsToSave.length > 0) {
        await this.dbService.get().bulkDocs(docsToSave, { new_edits: false });
        this.rulesEngineService.monitorExternalChanges({ docs: docsToSave });
        totalSaved += docsToSave.length;
      }

      // Update current seq for next iteration
      if (last_seq != null) {
        currentSeq = last_seq;
      }

      // If we got fewer docs than batch size, we're done
      if (docs.length < this.BATCH_SIZE) {
        break;
      }
    }

    return { read_docs: totalSaved, last_seq: currentSeq };
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

  private async getChanges(sinceSeq?: number):Promise<{ docs: any[], last_seq: number | null }> {
    let url = `/api/v1/replication/changes?limit=${this.BATCH_SIZE}`;
    if (sinceSeq) {
      url += `&since=${sinceSeq}`;
    }
    const getChangesReq = this.http.get<{ docs: any[], last_seq: number | null }>(
      url,
      { responseType: 'json' }
    );
    return await lastValueFrom(getChangesReq);
  }

}
