/**
 * FHIR R4 TypeScript interfaces for CHT integration
 * Based on resources stored in the fhir database
 */

export interface FhirResource {
  resourceType: string;
  id: string;
  meta?: FhirMeta;
}

export interface FhirMeta {
  lastUpdated?: string;
  tag?: FhirCoding[];
}

export interface FhirCoding {
  system?: string;
  code?: string;
  display?: string;
}

export interface FhirReference {
  reference?: string;
  display?: string;
}

export interface FhirIdentifier {
  system?: string;
  value?: string;
}

export interface FhirHumanName {
  use?: 'official' | 'nickname' | 'usual' | 'temp' | 'old' | 'maiden';
  text?: string;
  family?: string;
  given?: string[];
}

export interface FhirContactPoint {
  system?: 'phone' | 'email' | 'fax' | 'pager' | 'url' | 'sms' | 'other';
  value?: string;
  use?: 'home' | 'work' | 'temp' | 'old' | 'mobile';
  rank?: number;
}

export interface FhirExtension {
  url: string;
  valueString?: string;
  valueCode?: string;
  valueDateTime?: string;
  valueBoolean?: boolean;
}

export interface FhirCodeableConcept {
  coding?: FhirCoding[];
  text?: string;
}

// FHIR Patient Resource
export interface FhirPatient extends FhirResource {
  resourceType: 'Patient';
  identifier?: FhirIdentifier[];
  active?: boolean;
  name?: FhirHumanName[];
  telecom?: FhirContactPoint[];
  gender?: 'male' | 'female' | 'other' | 'unknown';
  birthDate?: string;
  extension?: FhirExtension[];
  contact?: FhirPatientContact[];
  managingOrganization?: FhirReference;
}

export interface FhirPatientContact {
  relationship?: FhirCodeableConcept[];
  organization?: FhirReference;
}

// FHIR Location Resource
export interface FhirLocation extends FhirResource {
  resourceType: 'Location';
  identifier?: FhirIdentifier[];
  status?: 'active' | 'suspended' | 'inactive';
  name?: string;
  description?: string;
  type?: FhirCodeableConcept[];
  telecom?: FhirContactPoint[];
  address?: FhirAddress;
  physicalType?: FhirCodeableConcept;
  partOf?: FhirReference;
}

export interface FhirAddress {
  use?: 'home' | 'work' | 'temp' | 'old' | 'billing';
  type?: 'postal' | 'physical' | 'both';
  text?: string;
  line?: string[];
  city?: string;
  district?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

// Union type for all FHIR resources we handle
export type FhirResourceType = FhirPatient | FhirLocation;

// Helper to check resource type
export function isFhirPatient(resource: FhirResource): resource is FhirPatient {
  return resource.resourceType === 'Patient';
}

export function isFhirLocation(resource: FhirResource): resource is FhirLocation {
  return resource.resourceType === 'Location';
}
