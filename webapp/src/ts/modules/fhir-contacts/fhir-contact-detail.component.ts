import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { FhirDbService } from '@mm-services/fhir-db.service';
import {
  FhirPatient,
  FhirLocation,
  FhirResource,
  isFhirPatient,
  isFhirLocation
} from '@mm-interfaces/fhir.types';

@Component({
  selector: 'mm-fhir-contact-detail',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './fhir-contact-detail.component.html',
  styleUrls: ['./fhir-contact-detail.component.scss']
})
export class FhirContactDetailComponent implements OnInit {
  resource: FhirPatient | FhirLocation | null = null;
  hierarchy: FhirLocation[] = [];
  children: FhirResource[] = [];
  loading = true;
  error: string | null = null;

  constructor(
    private route: ActivatedRoute,
    private fhirDbService: FhirDbService
  ) {}

  async ngOnInit() {
    this.route.params.subscribe(async (params) => {
      const id = params['id'];
      if (id) {
        await this.loadContact(id);
      }
    });
  }

  private async loadContact(id: string) {
    try {
      this.loading = true;
      this.error = null;

      // Fetch the main resource
      this.resource = await this.fhirDbService.get(id);

      if (this.resource && isFhirPatient(this.resource)) {
        await this.loadPatientDetails(this.resource);
      } else if (this.resource && isFhirLocation(this.resource)) {
        await this.loadLocationDetails(this.resource);
      }

    } catch (err) {
      console.error('Error loading FHIR contact:', err);
      this.error = 'Failed to load contact details. Please try again.';
    } finally {
      this.loading = false;
    }
  }

  private async loadPatientDetails(patient: FhirPatient) {
    // Load the managing organization hierarchy
    if (patient.managingOrganization?.reference) {
      const locationId = this.extractIdFromReference(patient.managingOrganization.reference);
      if (locationId) {
        await this.loadLocationHierarchy(locationId);
      }
    }
  }

  private async loadLocationDetails(location: FhirLocation) {
    // Load parent hierarchy
    await this.loadLocationHierarchy(location.id);

    // Load children (locations that have this location as partOf, or patients with this as managingOrganization)
    await this.loadChildren(location.id);
  }

  private async loadLocationHierarchy(locationId: string) {
    this.hierarchy = [];
    let currentId: string | null = locationId;

    // Follow the partOf chain up to the root
    while (currentId) {
      try {
        const location: FhirLocation = await this.fhirDbService.get(currentId);

        // Add to beginning of array (so we have root -> leaf order)
        this.hierarchy.unshift(location);

        // Get parent reference
        if (location.partOf?.reference) {
          currentId = this.extractIdFromReference(location.partOf.reference);
        } else {
          currentId = null;
        }
      } catch (err) {
        console.error('Error loading location in hierarchy:', err);
        break;
      }
    }
  }

  private async loadChildren(locationId: string) {
    try {
      // Get all documents and filter for children
      const result = await this.fhirDbService.allDocs({ include_docs: true });

      this.children = [];

      for (const row of result.rows) {
        const doc = row.doc as FhirResource;

        // Check if this is a child location
        if (isFhirLocation(doc)) {
          const parentId = doc.partOf?.reference ? this.extractIdFromReference(doc.partOf.reference) : null;
          if (parentId === locationId) {
            this.children.push(doc);
          }
        }

        // Check if this is a patient managed by this location
        if (isFhirPatient(doc)) {
          const managingOrgId = doc.managingOrganization?.reference
            ? this.extractIdFromReference(doc.managingOrganization.reference)
            : null;
          if (managingOrgId === locationId) {
            this.children.push(doc);
          }
        }
      }

      // Sort children by name
      this.children.sort((a, b) => {
        const nameA = this.getResourceName(a).toLowerCase();
        const nameB = this.getResourceName(b).toLowerCase();
        return nameA.localeCompare(nameB);
      });

    } catch (err) {
      console.error('Error loading children:', err);
    }
  }

  private extractIdFromReference(reference: string): string | null {
    // FHIR reference format: "ResourceType/id" or just "id"
    const parts = reference.split('/');
    return parts.length > 1 ? parts[1] : parts[0];
  }

  // Getter methods for display

  isPatient(): boolean {
    return this.resource ? isFhirPatient(this.resource) : false;
  }

  isLocation(): boolean {
    return this.resource ? isFhirLocation(this.resource) : false;
  }

  get patient(): FhirPatient | null {
    return this.resource && isFhirPatient(this.resource) ? this.resource : null;
  }

  get location(): FhirLocation | null {
    return this.resource && isFhirLocation(this.resource) ? this.resource : null;
  }

  getPatientName(patient: FhirPatient): string {
    if (!patient.name || patient.name.length === 0) {
      return 'Unknown';
    }

    const officialName = patient.name.find(n => n.use === 'official') || patient.name[0];

    if (officialName.text) {
      return officialName.text;
    }

    const parts: string[] = [];
    if (officialName.given) {
      parts.push(...officialName.given);
    }
    if (officialName.family) {
      parts.push(officialName.family);
    }

    return parts.length > 0 ? parts.join(' ') : 'Unknown';
  }

  getPatientPhone(patient: FhirPatient): string | null {
    if (!patient.telecom) {
      return null;
    }

    const phone = patient.telecom.find(t => t.system === 'phone');
    return phone?.value || null;
  }

  getLocationName(location: FhirLocation): string {
    return location.name || 'Unknown Location';
  }

  getResourceName(resource: FhirResource): string {
    if (isFhirPatient(resource)) {
      return this.getPatientName(resource);
    } else if (isFhirLocation(resource)) {
      return this.getLocationName(resource);
    }
    return 'Unknown';
  }

  getResourceType(resource: FhirResource): string {
    return resource.resourceType;
  }

  getResourceIcon(resource: FhirResource): string {
    if (isFhirPatient(resource)) {
      return 'fa-user';
    } else if (isFhirLocation(resource)) {
      const location = resource as FhirLocation;
      const typeName = location.meta?.tag?.find(t => t.system === 'urn:cht:meta')?.display?.toLowerCase() || '';

      if (typeName.includes('hospital')) {
        return 'fa-hospital';
      } else if (typeName.includes('health center')) {
        return 'fa-clinic-medical';
      } else if (typeName.includes('clinic') || typeName.includes('household')) {
        return 'fa-home';
      }

      return 'fa-map-marker-alt';
    }
    return 'fa-question';
  }

  getLocationDescription(location: FhirLocation): string | null {
    return location.description || null;
  }

  getLocationTypeName(location: FhirLocation): string {
    if (location.meta?.tag) {
      const chtTag = location.meta.tag.find(t => t.system === 'urn:cht:meta');
      if (chtTag?.display) {
        return chtTag.display;
      }
    }

    if (location.type && location.type.length > 0 && location.type[0].text) {
      return location.type[0].text;
    }

    return 'Location';
  }
}
