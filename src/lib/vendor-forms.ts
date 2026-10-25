import { has } from './values';

export const VENDOR_TYPES = [
  { id: 'company', label: 'Company' },
  { id: 'sole_trader', label: 'Sole trader' },
  { id: 'partnership', label: 'Partnership' },
  { id: 'ngo', label: 'NGO or association' },
  { id: 'government', label: 'Government body' },
] as const;

export const VENDOR_STATUS: Record<string, { label: string; tone: 'gray' | 'sky' | 'amber' | 'green' | 'red' }> = {
  registered: { label: 'Registered', tone: 'gray' },
  profile_in_progress: { label: 'Completing profile', tone: 'gray' },
  profile_submitted: { label: 'Profile submitted', tone: 'sky' },
  under_review: { label: 'Under review', tone: 'sky' },
  revision_requested: { label: 'Revision requested', tone: 'amber' },
  active: { label: 'Active', tone: 'green' },
  rejected: { label: 'Rejected', tone: 'red' },
  suspended: { label: 'Suspended', tone: 'amber' },
  archived: { label: 'Archived', tone: 'gray' },
};

export const VENDOR_BLOCK: Record<string, string> = { none: 'Not blocked', payment: 'Payments blocked', all: 'Blocked' };

export const vendorStatusChoices = (): { id: string; label: string }[] => Object.entries(VENDOR_STATUS).map(([id, v]) => ({ id, label: v.label }));

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** What a person types to register a vendor business; every field is trimmed by the server too. */
export interface VendorRegistration {
  legalName: string;
  contactName: string;
  email: string;
  phone: string;
  password: string;
}

export type FieldProblems = Record<string, string>;

export function checkRegistration(form: VendorRegistration, passwordProblem: string | null): FieldProblems {
  const problems: FieldProblems = {};
  if (form.legalName.trim().length < 2) problems.legalName = 'Enter the legal name of your business.';
  if (form.legalName.trim().length > 200) problems.legalName = 'The business name is too long (200 characters at most).';
  if (form.contactName.trim().length < 2) problems.contactName = 'Enter the name of the person who will sign in.';
  if (!EMAIL.test(form.email.trim())) problems.email = 'Enter a valid email address.';
  if (form.phone.trim() !== '' && !/^\+?[0-9 ()-]{7,20}$/.test(form.phone.trim())) problems.phone = 'Enter a phone number with 7 to 20 digits.';
  if (passwordProblem !== null) problems.password = passwordProblem;
  return problems;
}

/** What staff type to add a vendor. */
export interface VendorCreation {
  legalName: string;
  tradingName: string;
  vendorType: string;
  taxId: string;
  email: string;
  phone: string;
  country: string;
  paymentTermDays: string;
  currency: string;
  approvedExpenseVendor: boolean;
  notes: string;
}

export const emptyVendorCreation = (): VendorCreation => ({
  legalName: '',
  tradingName: '',
  vendorType: 'company',
  taxId: '',
  email: '',
  phone: '',
  country: '',
  paymentTermDays: '30',
  currency: '',
  approvedExpenseVendor: false,
  notes: '',
});

export function checkVendorCreation(form: VendorCreation): FieldProblems {
  const problems: FieldProblems = {};
  const name = form.legalName.trim();
  if (name.length < 2) problems.legalName = 'Enter the legal name of the business.';
  if (name.length > 200) problems.legalName = 'The legal name is too long (200 characters at most).';
  if (!EMAIL.test(form.email.trim())) problems.email = 'Enter a valid email address.';
  if (!VENDOR_TYPES.some((t) => t.id === form.vendorType)) problems.vendorType = 'Choose what kind of business this is.';
  if (has(form.phone) && !/^\+?[0-9 ()-]{7,20}$/.test(form.phone.trim())) problems.phone = 'Enter a phone number with 7 to 20 digits.';
  const days = Number(form.paymentTermDays);
  if (!/^\d{1,3}$/.test(form.paymentTermDays.trim()) || days > 365) problems.paymentTermDays = 'Payment terms are a whole number of days, 0 to 365.';
  if (has(form.currency) && !/^[A-Za-z]{3}$/.test(form.currency.trim())) problems.currency = 'A currency is a three-letter code such as KES.';
  if (form.notes.length > 2000) problems.notes = 'Notes are too long (2000 characters at most).';
  return problems;
}

/** Tax ids are compared without case or spaces so "p05 1234" and "P051234" are one vendor. */
export const normaliseTaxId = (value: string): string | null => {
  const v = value.replace(/\s+/g, '').toUpperCase();
  return v === '' ? null : v;
};
