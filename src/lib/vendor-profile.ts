import { has } from './values';
import { VENDOR_TYPES } from './vendor-forms';

/**
 * The vendor's profile: five sections, what each needs to be complete, and who may change which (design doc §6). Pure: the
 * server decides with these same rules, and the portal uses them only to tell the person what is missing.
 */

export type Section = 'profile' | 'business' | 'financial' | 'contacts' | 'attachments';

export const SECTIONS: readonly { id: Section; label: string; hint: string }[] = [
  { id: 'profile', label: 'Vendor profile', hint: 'Who you are, what you supply and where you are.' },
  { id: 'business', label: 'Business information', hint: 'Registration, tax and the people who own or run the business.' },
  { id: 'financial', label: 'Financial information', hint: 'Your bank account and the payment terms you offer.' },
  { id: 'contacts', label: 'Contact persons', hint: 'The people we deal with, and who is the main contact.' },
  { id: 'attachments', label: 'Attachments', hint: 'Certificates and letters we need to see.' },
];

export const sectionLabel = (id: string): string => SECTIONS.find((s) => s.id === id)?.label ?? id;
export const isSection = (value: string): value is Section => SECTIONS.some((s) => s.id === value);

export const CONTACT_ROLES = [
  { id: 'management', label: 'Management' },
  { id: 'sales', label: 'Sales' },
  { id: 'finance', label: 'Finance' },
  { id: 'technical', label: 'Technical' },
] as const;

export const ID_TYPES = [
  { id: 'national_id', label: 'National ID' },
  { id: 'passport', label: 'Passport' },
  { id: 'other', label: 'Other' },
] as const;

export const TURNOVER_BANDS = [
  { id: 'under_5m', label: 'Under 5 million' },
  { id: '5m_to_25m', label: '5 to 25 million' },
  { id: '25m_to_100m', label: '25 to 100 million' },
  { id: 'over_100m', label: 'Over 100 million' },
] as const;

export interface ProfileData {
  vendorType: string;
  tradingName: string;
  country: string;
  description: string;
  yearEstablished: string;
  website: string;
  physicalStreet: string;
  physicalCity: string;
  physicalCounty: string;
  physicalPostalCode: string;
  postalAddress: string;
  phone: string;
}

export interface BusinessData {
  registrationNo: string;
  registrationDate: string;
  taxId: string;
  vatNo: string;
  employeeCount: string;
  taxExempt: boolean;
}

export interface FinancialData {
  offeredPaymentTermDays: string;
  turnoverBand: string;
  mobileMoneyNumber: string;
}

export interface ContactInput {
  name: string;
  role: string;
  email: string;
  phone: string;
  isPrimary: boolean;
}

export interface DirectorInput {
  name: string;
  idType: string;
  idNumber: string;
  sharePercent: string;
}

export interface ReferenceInput {
  clientName: string;
  workDescription: string;
  valueAmount: string;
  contactName: string;
  contactPhone: string;
  year: string;
}

export type DestinationKind = 'bank' | 'mpesa_phone' | 'mpesa_paybill' | 'mpesa_till';

const MPESA_WORDS: Record<DestinationKind, string> = { bank: 'Bank', mpesa_phone: 'Phone', mpesa_paybill: 'Paybill', mpesa_till: 'Till' };

export const DESTINATION_KINDS: { id: DestinationKind; label: string }[] = [
  { id: 'bank', label: 'A bank account' },
  { id: 'mpesa_phone', label: 'An M-Pesa phone number' },
  { id: 'mpesa_paybill', label: 'An M-Pesa paybill' },
  { id: 'mpesa_till', label: 'An M-Pesa till' },
];

export interface BankInput {
  bankName: string;
  branch: string;
  accountName: string;
  accountNumber: string;
  swift: string;
  /** What the money goes to; empty means a bank account. */
  kind?: DestinationKind;
  /** For a paybill or till: the account number or reference a payment quotes. */
  reference?: string;
}

/** The kind a form says, a bank account when it says nothing. */
export const kindOf = (b: Pick<BankInput, 'kind'>): DestinationKind => b.kind ?? 'bank';

/** Words for a destination: where the money goes, without its number. */
export function describeDestination(kind: DestinationKind, bankName: string, branch: string, last4: string): string {
  if (kind === 'bank') return `${bankName}, ${branch} account ending ${last4}`;
  return `M-Pesa ${MPESA_WORDS[kind].toLowerCase()} ending ${last4}`;
}

export type Problems = Record<string, string>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9 ()-]{7,20}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const WHOLE = /^\d{1,9}$/;
const today = (): string => new Date().toISOString().slice(0, 10);

export const isRealDate = (value: string): boolean => DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export const emptyProfile = (): ProfileData => ({ vendorType: 'company', tradingName: '', country: '', description: '', yearEstablished: '', website: '', physicalStreet: '', physicalCity: '', physicalCounty: '', physicalPostalCode: '', postalAddress: '', phone: '' });
export const emptyBusiness = (): BusinessData => ({ registrationNo: '', registrationDate: '', taxId: '', vatNo: '', employeeCount: '', taxExempt: false });
export const emptyFinancial = (): FinancialData => ({ offeredPaymentTermDays: '', turnoverBand: '', mobileMoneyNumber: '' });

/** The tax id is held to the shape the company's country pack gives (`pattern`); with none, to a sensible length. */
export function checkProfile(d: ProfileData): Problems {
  const p: Problems = {};
  if (!VENDOR_TYPES.some((t) => t.id === d.vendorType)) p.vendorType = 'Choose what kind of business this is.';
  if (d.country.trim().length < 2) p.country = 'Enter the country your business is in.';
  const about = d.description.trim();
  if (about.length < 20) p.description = 'Describe what you supply in a sentence or two (at least 20 characters).';
  if (about.length > 2000) p.description = 'The description is too long (2000 characters at most).';
  if (d.physicalStreet.trim().length < 2) p.physicalStreet = 'Enter the street or building where you are.';
  if (d.physicalCity.trim().length < 2) p.physicalCity = 'Enter the town or city.';
  if (!PHONE.test(d.phone.trim())) p.phone = 'Enter a phone number with 7 to 20 digits.';
  if (has(d.yearEstablished)) {
    const year = Number(d.yearEstablished);
    if (!/^\d{4}$/.test(d.yearEstablished.trim()) || year < 1800 || year > new Date().getFullYear()) p.yearEstablished = 'Enter the year as four digits, for example 2012.';
  }
  if (has(d.website) && !/^https?:\/\/[^\s]+\.[^\s]+$/i.test(d.website.trim())) p.website = 'Enter the address starting with http:// or https://.';
  return p;
}

export function checkBusiness(d: BusinessData, taxPattern: RegExp | null = null): Problems {
  const p: Problems = {};
  if (d.registrationNo.trim().length < 3) p.registrationNo = 'Enter your business registration number.';
  if (!isRealDate(d.registrationDate.trim()) || d.registrationDate.trim() > today()) p.registrationDate = 'Enter the registration date, as a date that has already happened.';
  const tax = d.taxId.replace(/\s+/g, '');
  if (tax.length < 5 || tax.length > 30) p.taxId = 'Enter your tax ID (for Kenya, your KRA PIN).';
  else if (taxPattern !== null && !taxPattern.test(tax.toUpperCase())) p.taxId = 'That tax ID is not in the form we expect. Check it against your certificate.';
  if (has(d.employeeCount) && !WHOLE.test(d.employeeCount.trim())) p.employeeCount = 'Enter the number of employees as a whole number.';
  return p;
}

export function checkFinancial(d: FinancialData): Problems {
  const p: Problems = {};
  if (has(d.offeredPaymentTermDays) && (!/^\d{1,3}$/.test(d.offeredPaymentTermDays.trim()) || Number(d.offeredPaymentTermDays) > 365)) p.offeredPaymentTermDays = 'Payment terms are a whole number of days, 0 to 365.';
  if (has(d.turnoverBand) && !TURNOVER_BANDS.some((b) => b.id === d.turnoverBand)) p.turnoverBand = 'Choose one of the turnover bands.';
  if (has(d.mobileMoneyNumber) && !PHONE.test(d.mobileMoneyNumber.trim())) p.mobileMoneyNumber = 'Enter the mobile money number with 7 to 20 digits.';
  return p;
}

export function checkContacts(list: readonly ContactInput[]): Problems {
  const p: Problems = {};
  if (list.length === 0) p.contacts = 'Add at least one contact person.';
  if (list.length > 20) p.contacts = 'That is more contacts than we can keep (20 at most).';
  list.forEach((c, i) => {
    if (c.name.trim().length < 2) p[`contacts.${String(i)}.name`] = 'Enter the contact’s name.';
    if (!CONTACT_ROLES.some((r) => r.id === c.role)) p[`contacts.${String(i)}.role`] = 'Choose the contact’s role.';
    if (!EMAIL.test(c.email.trim())) p[`contacts.${String(i)}.email`] = 'Enter a valid email address.';
    if (!PHONE.test(c.phone.trim())) p[`contacts.${String(i)}.phone`] = 'Enter a phone number with 7 to 20 digits.';
  });
  const primaries = list.filter((c) => c.isPrimary).length;
  if (list.length > 0 && primaries !== 1) p.contacts = 'Choose exactly one main contact.';
  return p;
}

export function checkDirectors(list: readonly DirectorInput[]): Problems {
  const p: Problems = {};
  if (list.length === 0) p.directors = 'Add at least one owner or director.';
  if (list.length > 30) p.directors = 'That is more directors than we can keep (30 at most).';
  list.forEach((d, i) => {
    if (d.name.trim().length < 2) p[`directors.${String(i)}.name`] = 'Enter the person’s name.';
    if (!ID_TYPES.some((t) => t.id === d.idType)) p[`directors.${String(i)}.idType`] = 'Choose the kind of ID.';
    if (d.idNumber.trim().length < 4) p[`directors.${String(i)}.idNumber`] = 'Enter the ID number.';
    if (has(d.sharePercent) && !(Number(d.sharePercent) >= 0 && Number(d.sharePercent) <= 100)) p[`directors.${String(i)}.sharePercent`] = 'A share is a percentage from 0 to 100.';
  });
  const total = list.reduce((sum, d) => sum + (has(d.sharePercent) ? Number(d.sharePercent) : 0), 0);
  if (total > 100.0001) p.directors = 'The shares add up to more than 100%.';
  return p;
}

export function checkReferences(list: readonly ReferenceInput[]): Problems {
  const p: Problems = {};
  if (list.length > 20) p.references = 'That is more references than we can keep (20 at most).';
  list.forEach((r, i) => {
    if (r.clientName.trim().length < 2) p[`references.${String(i)}.clientName`] = 'Enter the client’s name.';
    if (has(r.valueAmount) && !/^\d{1,12}(\.\d{1,2})?$/.test(r.valueAmount.trim())) p[`references.${String(i)}.valueAmount`] = 'Enter the value as an amount.';
    if (has(r.contactPhone) && !PHONE.test(r.contactPhone.trim())) p[`references.${String(i)}.contactPhone`] = 'Enter a phone number with 7 to 20 digits.';
    if (has(r.year) && !/^\d{4}$/.test(r.year.trim())) p[`references.${String(i)}.year`] = 'Enter the year as four digits.';
  });
  return p;
}

export function checkBanks(list: readonly BankInput[]): Problems {
  const p: Problems = {};
  if (list.length > 5) p.banks = 'That is more bank accounts than we can keep (5 at most).';
  list.forEach((b, i) => {
    const kind = kindOf(b);
    if (!DESTINATION_KINDS.some((k) => k.id === kind)) p[`banks.${String(i)}.kind`] = 'Choose where the money goes.';
    if (b.accountName.trim().length < 2) p[`banks.${String(i)}.accountName`] = kind === 'bank' ? 'Enter the name the account is held in.' : 'Enter the name registered with M-Pesa.';
    if (kind !== 'bank') {
      const number = b.accountNumber.replace(/[\s-]+/g, '');
      if (kind === 'mpesa_phone' && !/^(\+?254|0)?[17]\d{8}$/.test(number)) p[`banks.${String(i)}.accountNumber`] = 'Enter the M-Pesa phone number, like 0712 345 678.';
      if (kind !== 'mpesa_phone' && !/^\d{5,7}$/.test(number)) p[`banks.${String(i)}.accountNumber`] = `Enter the ${kind === 'mpesa_paybill' ? 'paybill' : 'till'} number (5 to 7 digits).`;
      if (kind === 'mpesa_paybill' && !/^[A-Za-z0-9 ._-]{1,13}$/.test((b.reference ?? '').trim())) p[`banks.${String(i)}.reference`] = 'Enter the account number payments to the paybill quote (up to 13 characters).';
      if (kind === 'mpesa_till' && has(b.reference) && !/^[A-Za-z0-9 ._-]{1,13}$/.test((b.reference ?? '').trim())) p[`banks.${String(i)}.reference`] = 'The reference is up to 13 letters or digits.';
      return;
    }
    if (b.bankName.trim().length < 2) p[`banks.${String(i)}.bankName`] = 'Enter the bank’s name.';
    if (b.branch.trim().length < 2) p[`banks.${String(i)}.branch`] = 'Enter the branch.';
    if (!/^[A-Za-z0-9 -]{5,34}$/.test(b.accountNumber.trim())) p[`banks.${String(i)}.accountNumber`] = 'Enter the account number (5 to 34 letters and digits).';
    if (has(b.swift) && !/^[A-Za-z0-9]{8}([A-Za-z0-9]{3})?$/.test(b.swift.trim())) p[`banks.${String(i)}.swift`] = 'A SWIFT code has 8 or 11 characters.';
  });
  return p;
}

/** What the server knows about a vendor's profile, as plain data, for deciding completeness. */
export interface ProfileState {
  profile: ProfileData;
  business: BusinessData;
  financial: FinancialData;
  contacts: ContactInput[];
  directors: Pick<DirectorInput, 'name' | 'idType' | 'sharePercent'>[];
  references: ReferenceInput[];
  banks: number;
  /** Every document type the vendor must hold, with whether it does. */
  requiredDocuments: { code: string; name: string; held: boolean; needsExpiry: boolean; hasExpiry: boolean }[];
  taxPattern: RegExp | null;
}

export type SectionStatus = 'not_started' | 'draft' | 'complete';

/** What is still missing in a section, in plain words; empty means complete. */
export function missingIn(section: Section, s: ProfileState): string[] {
  switch (section) {
    case 'profile':
      return Object.values(checkProfile(s.profile));
    case 'business': {
      const asDirectors = s.directors.map((d) => ({ ...d, idNumber: '0000' }));
      return [...Object.values(checkBusiness(s.business, s.taxPattern)), ...Object.values(checkDirectors(asDirectors)), ...Object.values(checkReferences(s.references))];
    }
    case 'financial': {
      const out = Object.values(checkFinancial(s.financial));
      if (s.banks === 0) out.push('Add at least one bank account.');
      return out;
    }
    case 'contacts':
      return Object.values(checkContacts(s.contacts));
    case 'attachments': {
      const out: string[] = [];
      for (const d of s.requiredDocuments) {
        if (!d.held) out.push(`Upload your ${d.name}.`);
        else if (d.needsExpiry && !d.hasExpiry) out.push(`Enter the expiry date of your ${d.name}.`);
      }
      return out;
    }
  }
}

const started = (section: Section, s: ProfileState): boolean => {
  switch (section) {
    case 'profile':
      return has(s.profile.description) || has(s.profile.physicalStreet) || has(s.profile.country) || has(s.profile.tradingName);
    case 'business':
      return has(s.business.registrationNo) || has(s.business.taxId) || s.directors.length > 0;
    case 'financial':
      return s.banks > 0 || has(s.financial.offeredPaymentTermDays) || has(s.financial.mobileMoneyNumber);
    case 'contacts':
      return s.contacts.length > 0;
    case 'attachments':
      return s.requiredDocuments.some((d) => d.held);
  }
};

export function sectionStatus(section: Section, s: ProfileState): SectionStatus {
  if (missingIn(section, s).length === 0) return 'complete';
  return started(section, s) ? 'draft' : 'not_started';
}

export function allStatuses(s: ProfileState): Record<Section, SectionStatus> {
  return { profile: sectionStatus('profile', s), business: sectionStatus('business', s), financial: sectionStatus('financial', s), contacts: sectionStatus('contacts', s), attachments: sectionStatus('attachments', s) };
}

export const profileComplete = (s: ProfileState): boolean => SECTIONS.every((x) => sectionStatus(x.id, s) === 'complete');

/** The statuses in which a vendor may change its profile itself (a refused one only after the waiting period). */
export const EDITABLE_STATUSES = ['registered', 'profile_in_progress', 'revision_requested'] as const;
export const REAPPLY_AFTER_DAYS = 30;

export function mayEditProfile(status: string, decidedAt: Date | null, now: Date): boolean {
  if ((EDITABLE_STATUSES as readonly string[]).includes(status)) return true;
  if (status === 'rejected' && decidedAt !== null) return now.getTime() - decidedAt.getTime() >= REAPPLY_AFTER_DAYS * 86_400_000;
  return false;
}

/** Which portal roles may change which section (design §5.3). */
export function mayEditSection(portalRole: string, section: Section): boolean {
  if (portalRole === 'owner') return true;
  if (portalRole === 'finance') return section === 'financial' || section === 'attachments';
  if (portalRole === 'sales') return section === 'contacts' || section === 'attachments';
  return false;
}

/** The submitted-for-review statuses: the vendor can look but not change. */
export const LOCKED_FOR_REVIEW = ['profile_submitted', 'under_review'] as const;

/** Account numbers are shown by their last four digits only. */
export const maskAccount = (last4: string): string => `•••• ${last4}`;

/**
 * Whether a person may change a section right now: exactly "yes", or the plain reason they may not. Before approval (and after a
 * revision request) the whole profile is open; an approved vendor changes only its contacts and documents itself, because
 * who it is and where it is paid are controlled changes; while the profile is with the reviewer nothing changes.
 */
export function mayEditProfileNow(status: string, decidedAt: Date | null, now: Date, portalRole: string, section: Section): string {
  if (!mayEditSection(portalRole, section)) return 'Your role on this account does not let you change this part.';
  if (mayEditProfile(status, decidedAt, now)) return 'yes';
  if ((LOCKED_FOR_REVIEW as readonly string[]).includes(status)) return 'Your profile is with the reviewer. You can change it again if they ask you to revise something.';
  if (status === 'active' || status === 'suspended') {
    return section === 'contacts' || section === 'attachments' ? 'yes' : 'This part is already approved. To change it, contact the buyer.';
  }
  if (status === 'rejected') return `Your application was not accepted. You can apply again ${String(REAPPLY_AFTER_DAYS)} days after the decision.`;
  return 'Your account cannot be changed right now.';
}

/** The word an M-Pesa destination goes by in the branch column. */
export const mpesaWord = (kind: DestinationKind): string => MPESA_WORDS[kind];

/** What to call the number of each kind of destination on a form. */
export const NUMBER_LABELS: Record<DestinationKind, string> = { bank: 'Account number', mpesa_phone: 'M-Pesa phone number', mpesa_paybill: 'Paybill number', mpesa_till: 'Till number' };

/** The number as it is kept: letters upper case, no spaces or dashes; an M-Pesa phone as 2547… or 2541… with the country code. */
export function numberOf(b: Pick<BankInput, 'accountNumber' | 'kind'>): string {
  const plain = b.accountNumber.replace(/[\s-]+/g, '').toUpperCase();
  if (kindOf(b) !== 'mpesa_phone') return plain;
  const digits = plain.replace(/^\+/, '');
  if (digits.startsWith('254')) return digits;
  return `254${digits.replace(/^0/, '')}`;
}

/** The label for a destination's number, whatever kind a form currently holds (a bank account when it holds none we know). */
export const numberLabel = (kind: string): string => NUMBER_LABELS[DESTINATION_KINDS.find((k) => k.id === kind)?.id ?? 'bank'];
