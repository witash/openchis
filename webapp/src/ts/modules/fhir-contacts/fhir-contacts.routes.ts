import { Routes } from '@angular/router';
import { FhirContactsComponent } from './fhir-contacts.component';
import { FhirContactDetailComponent } from './fhir-contact-detail.component';

export const routes: Routes = [
  {
    path: 'fhir-contacts',
    component: FhirContactsComponent,
    data: { name: 'fhir-contacts.list', tab: 'fhir-contacts' }
  },
  {
    path: 'fhir-contacts/:id',
    component: FhirContactDetailComponent,
    data: { name: 'fhir-contacts.detail', tab: 'fhir-contacts' }
  }
];
