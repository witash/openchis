import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { FhirDbService } from '@mm-services/fhir-db.service';
import {
  FhirPatient,
  FhirLocation,
  FhirResourceType,
  isFhirPatient,
  isFhirLocation
} from '@mm-interfaces/fhir.types';

@Component({
  selector: 'mm-fhir-contacts',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './fhir-contacts.component.html',
  styleUrls: ['./fhir-contacts.component.scss']
})
export class FhirContactsComponent implements OnInit {
  patients: FhirPatient[] = [];
  locations: FhirLocation[] = [];
  loading = true;
  error: string | null = null;

  constructor(private fhirDbService: FhirDbService) {}

  async ngOnInit() {
    await this.loadAllContacts();
  }

  private async loadAllContacts() {
    try {
      this.loading = true;
      this.error = null;

      // Get all document IDs from the FHIR database
      const result = await this.fhirDbService.allDocs({ include_docs: true });

      // Separate patients and locations
      for (const row of result.rows) {
        const doc = row.doc as FhirResourceType;

        if (isFhirPatient(doc)) {
          this.patients.push(doc);
        } else if (isFhirLocation(doc)) {
          this.locations.push(doc);
        }
      }

      // Sort patients by name
      this.patients.sort((a, b) => {
        const nameA = this.getPatientName(a).toLowerCase();
        const nameB = this.getPatientName(b).toLowerCase();
        return nameA.localeCompare(nameB);
      });

      // Sort locations by name
      this.locations.sort((a, b) => {
        const nameA = (a.name || '').toLowerCase();
        const nameB = (b.name || '').toLowerCase();
        return nameA.localeCompare(nameB);
      });

    } catch (err) {
      console.error('Error loading FHIR contacts:', err);
      this.error = 'Failed to load contacts. Please try again.';
    } finally {
      this.loading = false;
    }
  }

  // Getter methods for extracting FHIR fields

  getPatientName(patient: FhirPatient): string {
    if (!patient.name || patient.name.length === 0) {
      return 'Unknown';
    }

    const officialName = patient.name.find(n => n.use === 'official') || patient.name[0];

    if (officialName.text) {
      return officialName.text;
    }

    const parts: string[] = [];
    if (officialName.given && officialName.given.length > 0) {
      parts.push(...officialName.given);
    }
    if (officialName.family) {
      parts.push(officialName.family);
    }

    return parts.length > 0 ? parts.join(' ') : 'Unknown';
  }

  getPatientNickname(patient: FhirPatient): string | null {
    if (!patient.name) {
      return null;
    }

    const nickname = patient.name.find(n => n.use === 'nickname');
    if (nickname?.given && nickname.given.length > 0) {
      return nickname.given[0];
    }

    return null;
  }

  getPatientPhone(patient: FhirPatient): string | null {
    if (!patient.telecom || patient.telecom.length === 0) {
      return null;
    }

    const phone = patient.telecom.find(t => t.system === 'phone');
    return phone?.value || null;
  }

  getPatientGender(patient: FhirPatient): string {
    return patient.gender || 'unknown';
  }

  getPatientBirthDate(patient: FhirPatient): string | null {
    return patient.birthDate || null;
  }

  getLocationName(location: FhirLocation): string {
    return location.name || 'Unknown Location';
  }

  getLocationTypeName(location: FhirLocation): string {
    if (!location.meta?.tag) {
      return 'Location';
    }

    const chtTag = location.meta.tag.find(t => t.system === 'urn:cht:meta');
    if (chtTag?.display) {
      return chtTag.display;
    }

    if (location.type && location.type.length > 0 && location.type[0].text) {
      return location.type[0].text;
    }

    return 'Location';
  }

  getLocationIcon(location: FhirLocation): string {
    // Determine icon based on location type
    const typeName = this.getLocationTypeName(location).toLowerCase();

    if (typeName.includes('hospital')) {
      return 'fa-hospital';
    } else if (typeName.includes('health center')) {
      return 'fa-clinic-medical';
    } else if (typeName.includes('clinic') || typeName.includes('household')) {
      return 'fa-home';
    }

    return 'fa-map-marker-alt';
  }

  getPatientIcon(): string {
    return 'fa-user';
  }

  async refresh() {
    this.patients = [];
    this.locations = [];
    await this.loadAllContacts();
  }
}
