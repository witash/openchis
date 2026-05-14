import { Injectable } from '@angular/core';
import { lastValueFrom } from 'rxjs';
import { HttpClient } from '@angular/common/http';

import { DbService } from '@mm-services/db.service';
import { RulesEngineService } from '@mm-services/rules-engine.service';

// Per-device pg-sync state. PouchDB `_local/` docs are not replicated and have
// no revision history; this keeps the cursor scoped to the current PouchDB
// (i.e. the signed-in user) rather than to the browser origin like
// localStorage would.
const STATE_DOC_ID = '_local/medic-pg-sync-state';
const PG_SYNC_URL = '/api/v1/pg-sync';

interface PgSyncResponse {
  docs: any[];
  last_seq: number | string;
}

interface PgSyncStateDoc {
  _id: string;
  _rev?: string;
  last_seq?: number | string;
}

@Injectable({
  providedIn: 'root'
})
export class PgReplicationService {
  constructor(
    private dbService: DbService,
    private http: HttpClient,
    private rulesEngineService: RulesEngineService,
  ) {}

  private async getStateDoc(): Promise<PgSyncStateDoc> {
    try {
      return await this.dbService.get().get(STATE_DOC_ID);
    } catch (err) {
      if (err && err.status === 404) {
        return { _id: STATE_DOC_ID };
      }
      throw err;
    }
  }

  private async setLastSeq(existing: PgSyncStateDoc, seq) {
    if (seq === undefined || seq === null) {
      return;
    }
    const next: PgSyncStateDoc = { ...existing, last_seq: seq };
    await this.dbService.get().put(next);
  }

  async replicateFrom(): Promise<{ read_docs: number }> {
    const state = await this.getStateDoc();
    const since = state.last_seq ?? 0;

    const response = await this.fetchPgSync(since);
    const docs = Array.isArray(response?.docs) ? response.docs : [];

    if (docs.length) {
      await this.applyDocs(docs);
    }

    await this.setLastSeq(state, response.last_seq);
    return { read_docs: docs.length };
  }

  private async fetchPgSync(since): Promise<PgSyncResponse> {
    return lastValueFrom(
      this.http.post<PgSyncResponse>(
        PG_SYNC_URL,
        { since },
        { responseType: 'json' }
      )
    );
  }

  private async applyDocs(docs) {
    await this.dbService.get().bulkDocs(docs, { new_edits: false });
    const upserts = docs.filter(d => d && !d._deleted);
    if (upserts.length) {
      this.rulesEngineService.monitorExternalChanges({ docs: upserts });
    }
  }
}
