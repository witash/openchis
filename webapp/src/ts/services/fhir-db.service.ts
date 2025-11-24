import { Injectable, NgZone } from '@angular/core';
import { POUCHDB_OPTIONS } from '../constants';

@Injectable({
  providedIn: 'root'
})
export class FhirDbService {
  private db: any;

  private readonly POUCHDB_METHODS = {
    get: this.outOfZonePromise.bind(this),
    allDocs: this.outOfZonePromise.bind(this),
    bulkGet: this.outOfZonePromise.bind(this),
    query: this.outOfZonePromise.bind(this),
  };

  constructor(private ngZone: NgZone) {
    this.initializeDb();
  }

  private outOfZonePromise(fn, db) {
    return (...args) => this.ngZone.runOutsideAngular(() => fn.apply(db, args));
  }

  private wrapMethods(db) {
    for (const method in this.POUCHDB_METHODS) {
      if (this.POUCHDB_METHODS[method]) {
        db[method] = this.POUCHDB_METHODS[method](db[method], db);
      }
    }
    return db;
  }

  private initializeDb() {
    const dbUrl = 'http://medic:password@localhost:5988/fhir';
    const options = Object.assign({}, POUCHDB_OPTIONS.remote);
    this.db = this.wrapMethods(window.PouchDB(dbUrl, options));
  }

  /**
   * Get all documents from the FHIR database
   */
  allDocs(options = {}) {
    return this.db.allDocs(options);
  }

  /**
   * Get a single document by ID
   */
  get(id: string) {
    return this.db.get(id);
  }

  /**
   * Get multiple documents by IDs
   */
  bulkGet(ids: string[]) {
    return this.db.bulkGet({ docs: ids.map(id => ({ id })) });
  }

  /**
   * Query a view
   */
  query(viewName: string, options = {}) {
    return this.db.query(viewName, options);
  }
}
