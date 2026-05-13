import { Injectable } from '@angular/core';
import { lastValueFrom } from 'rxjs';
import { HttpClient } from '@angular/common/http';

import { DbService } from '@mm-services/db.service';
import { RulesEngineService } from '@mm-services/rules-engine.service';

// PoC feature flag: when 'true', offline-client download flows through
// /api/v1/pg-sync instead of the legacy get-ids / Nairobi path.
// Stored in localStorage (per-device, survives restarts, no async load).
const FLAG_KEY = 'medic-pg-sync-enabled';
const LAST_SEQ_KEY = 'medic-pg-sync-last-seq';
const CUTOVER_KEY = 'medic-pg-sync-cutover-done';

const PG_SYNC_URL = '/api/v1/pg-sync';
const PG_SYNC_CUTOVER_URL = '/api/v1/pg-sync/cutover';

interface PgSyncResponse {
  docs: any[];
  last_seq: number | string;
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

  isEnabled(): boolean {
    return window.localStorage.getItem(FLAG_KEY) === 'true';
  }

  private getLastSeq(): number | string {
    const raw = window.localStorage.getItem(LAST_SEQ_KEY);
    if (raw === null || raw === undefined) {
      return 0;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }

  private setLastSeq(seq) {
    if (seq === undefined || seq === null) {
      return;
    }
    window.localStorage.setItem(LAST_SEQ_KEY, String(seq));
  }

  private isCutoverDone(): boolean {
    return window.localStorage.getItem(CUTOVER_KEY) === 'true';
  }

  private markCutoverDone() {
    window.localStorage.setItem(CUTOVER_KEY, 'true');
  }

  async replicateFrom(): Promise<{ read_docs: number }> {
    if (!this.isCutoverDone()) {
      await this.recordCutover();
    }

    const since = this.getLastSeq();
    const response = await this.fetchPgSync(since);
    const docs = Array.isArray(response?.docs) ? response.docs : [];

    if (docs.length) {
      await this.applyDocs(docs);
    }

    this.setLastSeq(response.last_seq);
    return { read_docs: docs.length };
  }

  private async recordCutover() {
    const info = await this.dbService.get().info();
    const body = { pouchdb_seq: info?.update_seq ?? null };
    await lastValueFrom(
      this.http.post(PG_SYNC_CUTOVER_URL, body, { responseType: 'json' })
    );
    this.markCutoverDone();
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
