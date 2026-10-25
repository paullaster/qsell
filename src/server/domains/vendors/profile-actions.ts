'use server';

import { getContainer } from '@/server/di/container';
import { mayEditProfileNow, sectionLabel, SECTIONS, isSection, type BusinessData, type ContactInput, type ReferenceInput, type Section } from '@/lib/vendor-profile';
import { portal } from './portal-runner';
import { ProfileError } from './profile-service';

/** The browser's values are never trusted to be the right type: each named field becomes a string, anything else an empty one. */
function strings<K extends string>(raw: unknown, keys: readonly K[]): Record<K, string> {
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(keys.map((k) => [k, typeof source[k] === 'string' ? source[k] : ''])) as Record<K, string>;
}

const list = (raw: unknown): unknown[] => (Array.isArray(raw) ? raw.slice(0, 50) : []);

const PROFILE_KEYS = ['vendorType', 'tradingName', 'country', 'description', 'yearEstablished', 'website', 'physicalStreet', 'physicalCity', 'physicalCounty', 'physicalPostalCode', 'postalAddress', 'phone'] as const;
const BUSINESS_KEYS = ['registrationNo', 'registrationDate', 'taxId', 'vatNo', 'employeeCount'] as const;
const FINANCIAL_KEYS = ['offeredPaymentTermDays', 'turnoverBand', 'mobileMoneyNumber'] as const;

/** Where the vendor stands: each section's status and what is missing, what the reviewer asked for, and what it may do now. */
export async function profileOverviewAction() {
  return await portal('profile_overview', async (me) => {
    const container = getContainer();
    const found = await container.vendorProfile.statuses(me.companyId, me.vendorId);
    if (found === null) throw new ProfileError('NOT_FOUND', 'Your vendor account could not be found.');
    const notes = await container.vendorProfile.revisionNotes(me.vendorId);
    const now = new Date();
    const v = found.vendor;
    const canEdit = Object.fromEntries(SECTIONS.map((s) => [s.id, mayEditProfileNow(v.status, v.decidedAt, now, me.portalRole, s.id) === 'yes'])) as Record<Section, boolean>;
    const submitVerdict = me.portalRole === 'owner' ? mayEditProfileNow(v.status, v.decidedAt, now, me.portalRole, 'profile') : 'Only the owner of the vendor account can send the profile for review.';
    return {
      status: v.status,
      sections: SECTIONS.map((s) => ({ id: s.id, label: s.label, hint: s.hint, status: found.statuses[s.id], missing: found.missing[s.id], note: notes[s.id] ?? null, canEdit: canEdit[s.id] })),
      complete: found.complete,
      canSubmit: found.complete && submitVerdict === 'yes' && (v.status === 'registered' || v.status === 'profile_in_progress' || v.status === 'revision_requested' || v.status === 'rejected'),
      submitBlockedBecause: submitVerdict === 'yes' ? null : submitVerdict,
    };
  });
}

/** The values to fill a section's form with. Sealed numbers are never sent: only their last four digits. */
export async function profileFormAction(section: string) {
  return await portal('profile_form', async (me) => {
    if (!isSection(section)) throw new ProfileError('NOT_FOUND', 'That part of the profile does not exist.');
    const container = getContainer();
    const loaded = await container.vendorProfile.load(me.companyId, me.vendorId);
    if (loaded === null) throw new ProfileError('NOT_FOUND', 'Your vendor account could not be found.');
    const state = container.vendorProfile.toState(loaded);
    const verdict = mayEditProfileNow(loaded.vendor.status, loaded.vendor.decidedAt, new Date(), me.portalRole, section);
    const notes = await container.vendorProfile.revisionNotes(me.vendorId);
    return {
      section,
      label: sectionLabel(section),
      canEdit: verdict === 'yes',
      readOnlyBecause: verdict === 'yes' ? null : verdict,
      note: notes[section] ?? null,
      profile: state.profile,
      business: state.business,
      financial: state.financial,
      contacts: state.contacts,
      directors: loaded.directors.map((d) => ({ id: d.id, name: d.name, idType: d.idType, idLast4: d.idLast4, sharePercent: d.sharePercent ?? '' })),
      references: state.references,
      banks: loaded.banks.map((b) => ({ id: b.id, bankName: b.bankName, branch: b.branch, accountName: b.accountName, last4: b.accountLast4, swift: b.swift ?? '', status: b.status })),
      documents: loaded.types
        .filter((t) => t.isActive)
        .map((t) => {
          const current = loaded.documents.find((d) => d.doc.documentTypeId === t.id);
          return {
            typeId: t.id,
            name: t.name,
            required: t.requiredForAll,
            needsExpiry: t.needsExpiry,
            current: current === undefined ? null : { id: current.doc.id, fileId: current.doc.fileId, fileName: current.fileName, status: current.doc.status, expiresOn: current.doc.expiresOn, note: current.doc.note },
          };
        }),
    };
  });
}

export async function saveProfileAction(raw: unknown) {
  return await portal('save_profile', async (me) => {
    await getContainer().vendorProfile.saveProfile(me, strings(raw, PROFILE_KEYS));
  });
}

export async function saveBusinessAction(raw: unknown) {
  return await portal('save_business', async (me) => {
    const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const data: BusinessData = { ...strings(raw, BUSINESS_KEYS), taxExempt: source.taxExempt === true };
    await getContainer().vendorProfile.saveBusiness(me, data);
  });
}

export async function addDirectorAction(raw: unknown) {
  return await portal('add_director', async (me) => {
    await getContainer().vendorProfile.addDirector(me, strings(raw, ['name', 'idType', 'idNumber', 'sharePercent'] as const));
  });
}

export async function removeDirectorAction(id: unknown) {
  return await portal('remove_director', async (me) => {
    await getContainer().vendorProfile.removeDirector(me, typeof id === 'string' ? id : '');
  });
}

export async function saveReferencesAction(raw: unknown) {
  return await portal('save_references', async (me) => {
    const refs = list(raw).map((r) => strings(r, ['clientName', 'workDescription', 'valueAmount', 'contactName', 'contactPhone', 'year'] as const) as ReferenceInput);
    await getContainer().vendorProfile.saveReferences(me, refs);
  });
}

export async function saveFinancialAction(raw: unknown) {
  return await portal('save_financial', async (me) => {
    await getContainer().vendorProfile.saveFinancial(me, strings(raw, FINANCIAL_KEYS));
  });
}

export async function addBankAction(raw: unknown) {
  return await portal('add_bank', async (me) => {
    await getContainer().vendorProfile.addBank(me, strings(raw, ['bankName', 'branch', 'accountName', 'accountNumber', 'swift'] as const));
  });
}

export async function removeBankAction(id: unknown) {
  return await portal('remove_bank', async (me) => {
    await getContainer().vendorProfile.removeBank(me, typeof id === 'string' ? id : '');
  });
}

export async function saveContactsAction(raw: unknown) {
  return await portal('save_contacts', async (me) => {
    const contacts = list(raw).map((c) => {
      const source = typeof c === 'object' && c !== null ? (c as Record<string, unknown>) : {};
      return { ...strings(c, ['name', 'role', 'email', 'phone'] as const), isPrimary: source.isPrimary === true } satisfies ContactInput;
    });
    await getContainer().vendorProfile.saveContacts(me, contacts);
  });
}

export async function removeDocumentAction(id: unknown) {
  return await portal('remove_document', async (me) => {
    await getContainer().vendorProfile.removeDocument(me, typeof id === 'string' ? id : '');
  });
}

/** Sends the profile for review (owner only; every section complete). */
export async function submitProfileAction() {
  return await portal('submit_profile', async (me) => {
    return await getContainer().vendorProfile.submit(me, me.companyId);
  }, 'vendor_submit');
}
