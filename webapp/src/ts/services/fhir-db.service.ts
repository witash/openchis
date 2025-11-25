import { Injectable, NgZone } from '@angular/core';
import { POUCHDB_OPTIONS } from '../constants';
import { StructureMapProcessorService } from './structure-map-processor.service';

@Injectable({
  providedIn: 'root'
})
export class FhirDbService {
  private medicDb: any;
  private fhirDb: any;
  private structureMapsLoaded = false;

  private readonly POUCHDB_METHODS = {
    get: this.outOfZonePromise.bind(this),
    allDocs: this.outOfZonePromise.bind(this),
    bulkGet: this.outOfZonePromise.bind(this),
    query: this.outOfZonePromise.bind(this),
  };

  constructor(
    private ngZone: NgZone,
    private structureMapProcessor: StructureMapProcessorService
  ) {
    this.initializeDb();
    this.loadStructureMaps();
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
    const options = Object.assign({}, POUCHDB_OPTIONS.remote);

    // Connect to the medic database (for CHT documents)
    const medicDbUrl = 'http://medic:password@localhost:5988/medic';
    this.medicDb = this.wrapMethods(window.PouchDB(medicDbUrl, options));

    // Connect to the fhir database (for StructureMaps)
    const fhirDbUrl = 'http://medic:password@localhost:5988/fhir';
    this.fhirDb = this.wrapMethods(window.PouchDB(fhirDbUrl, options));
  }

  /**
   * Load StructureMaps from fhir database
   */
  private async loadStructureMaps() {
    try {
      // Load StructureMaps from the fhir database
      const personMap = await this.fhirDb.get('cht-person-to-fhir-patient');
      const placeMap = await this.fhirDb.get('cht-place-to-fhir-location');

      // Remove CouchDB metadata
      delete personMap._id;
      delete personMap._rev;
      delete placeMap._id;
      delete placeMap._rev;

      this.structureMapProcessor.loadStructureMap(personMap);
      this.structureMapProcessor.loadStructureMap(placeMap);
      this.structureMapsLoaded = true;

      console.log('✓ FHIR StructureMaps loaded successfully from database');
    } catch (error) {
      console.error('Failed to load StructureMaps from database:', error);
    }
  }

  /**
   * Wait for StructureMaps to be loaded
   */
  private async ensureStructureMapsLoaded(): Promise<void> {
    if (this.structureMapsLoaded) {
      return;
    }

    // Wait for up to 5 seconds
    for (let i = 0; i < 50; i++) {
      if (this.structureMapsLoaded) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    throw new Error('Timeout waiting for StructureMaps to load');
  }

  /**
   * Transform a CHT document to FHIR resource
   */
  private async transformChtToFhir(chtDoc: any): Promise<any> {
    await this.ensureStructureMapsLoaded();

    try {
      return this.structureMapProcessor.transformChtDocument(chtDoc);
    } catch (error) {
      console.error('Failed to transform CHT document:', error, chtDoc);
      // Return original document on error
      return chtDoc;
    }
  }

  /**
   * Filter CHT documents to only include contacts/places
   */
  private isChtContact(doc: any): boolean {
    const contactTypes = ['person', 'clinic', 'health_center', 'district_hospital'];
    return doc.type && contactTypes.includes(doc.type);
  }

  /**
   * Get all documents from the medic database and transform to FHIR
   */
  async allDocs(options: any = {}): Promise<any> {
    // Always include docs so we can transform them
    const queryOptions = { ...options, include_docs: true };

    const result = await this.medicDb.allDocs(queryOptions);

    // Transform each document
    const transformedRows: any[] = [];

    for (const row of result.rows) {
      if (row.doc && this.isChtContact(row.doc)) {
        try {
          const fhirResource = await this.transformChtToFhir(row.doc);
          transformedRows.push({
            id: row.id,
            key: row.key,
            value: row.value,
            doc: fhirResource
          });
        } catch (error) {
          console.error('Failed to transform document:', row.id, error);
        }
      }
    }

    return {
      total_rows: transformedRows.length,
      offset: 0,
      rows: transformedRows
    };
  }

  /**
   * Get a single document by ID and transform to FHIR
   */
  async get(id: string): Promise<any> {
    const chtDoc = await this.medicDb.get(id);

    if (!this.isChtContact(chtDoc)) {
      throw new Error(`Document ${id} is not a CHT contact`);
    }

    return this.transformChtToFhir(chtDoc);
  }

  /**
   * Get multiple documents by IDs and transform to FHIR
   */
  async bulkGet(ids: string[]): Promise<any> {
    const result = await this.medicDb.bulkGet({ docs: ids.map(id => ({ id })) });

    // Transform each document
    const transformedResults: any[] = [];

    for (const item of result.results) {
      if (item.docs && item.docs.length > 0) {
        const doc = item.docs[0];
        if (doc.ok && this.isChtContact(doc.ok)) {
          try {
            const fhirResource = await this.transformChtToFhir(doc.ok);
            transformedResults.push({
              id: item.id,
              docs: [{ ok: fhirResource }]
            });
          } catch (error) {
            console.error('Failed to transform document:', item.id, error);
          }
        }
      }
    }

    return {
      results: transformedResults
    };
  }

  /**
   * Query a view (not transformed - for advanced use)
   */
  query(viewName: string, options = {}) {
    return this.medicDb.query(viewName, options);
  }
}
