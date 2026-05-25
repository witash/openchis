import { Injectable } from '@angular/core';
import { lastValueFrom } from 'rxjs';
import { HttpClient } from '@angular/common/http';

import { DbService } from '@mm-services/db.service';
import { RulesEngineService } from '@mm-services/rules-engine.service';

const PG_SYNC_URL = '/api/v1/pg-sync';

interface PgSyncResponse {
  docs: any[];
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

  async replicateFrom(): Promise<{ read_docs: number }> {
    const response = await this.fetchPgSync();
    const docs = Array.isArray(response?.docs) ? response.docs : [];

    if (docs.length) {
      await this.applyDocs(docs);
    }

    return { read_docs: docs.length };
  }

  private async fetchPgSync(): Promise<PgSyncResponse> {
    return lastValueFrom(
      this.http.post<PgSyncResponse>(PG_SYNC_URL, {}, { responseType: 'json' })
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
