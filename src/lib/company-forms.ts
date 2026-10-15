import type { CompanySettingsRow } from '@/server/db/drizzle/schema';
import { normalizeHexColor } from '@/config/company-ui/theme';
import { PRODUCT_GRID_DESKTOP_COLUMNS, type ProductGridDesktopColumns } from '@/config/company-ui/types';
import { has } from '@/lib/values';

/** The company profile as the form holds it: every field text, an empty box meaning "not set". */
export interface ProfileForm {
  legalName: string;
  tradingName: string;
  tagline: string;
  email: string;
  phone: string;
  tel: string;
  website: string;
  streetAddress: string;
  city: string;
  countyOrState: string;
  postalCode: string;
  country: string;
  locationLabel: string;
  kraPin: string;
  vatNumber: string;
  registrationNumber: string;
  invoicePrefix: string;
  invoiceFooterNote: string;
  bankName: string;
  bankBranch: string;
  bankAccountName: string;
  bankAccountNumber: string;
}

/** What the profile screen reads: the form's fields plus the logo, which has its own upload. */
export type ProfileView = ProfileForm & { logoUrl: string | null; accentColor: string };

export const profileFormFrom = (row: CompanySettingsRow): ProfileView => ({
  legalName: row.legalName,
  tradingName: row.tradingName,
  tagline: row.tagline ?? '',
  email: row.email,
  phone: row.phone,
  tel: row.tel ?? '',
  website: row.website ?? '',
  streetAddress: row.streetAddress,
  city: row.city,
  countyOrState: row.countyOrState,
  postalCode: row.postalCode,
  country: row.country,
  locationLabel: row.locationLabel ?? '',
  kraPin: row.kraPin,
  vatNumber: row.vatNumber ?? '',
  registrationNumber: row.registrationNumber ?? '',
  invoicePrefix: row.invoicePrefix,
  invoiceFooterNote: row.invoiceFooterNote ?? '',
  bankName: row.bankName ?? '',
  bankBranch: row.bankBranch ?? '',
  bankAccountName: row.bankAccountName ?? '',
  bankAccountNumber: row.bankAccountNumber ?? '',
  logoUrl: row.logoUrl,
  accentColor: row.accentColor,
});

export type ProfileUpdate = Omit<{ [K in keyof ProfileForm]: ProfileForm[K] }, 'tagline' | 'tel' | 'website' | 'locationLabel' | 'vatNumber' | 'registrationNumber' | 'invoiceFooterNote' | 'bankName' | 'bankBranch' | 'bankAccountName' | 'bankAccountNumber'> & {
  tagline: string | null;
  tel: string | null;
  website: string | null;
  locationLabel: string | null;
  vatNumber: string | null;
  registrationNumber: string | null;
  invoiceFooterNote: string | null;
  bankName: string | null;
  bankBranch: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9][0-9\s()-]{5,22}$/;
const KRA_PIN = /^[AP]\d{9}[A-Z]$/;
const PREFIX = /^[A-Z0-9-]{1,10}$/;

const REQUIRED: [keyof ProfileForm, string, number][] = [
  ['legalName', 'Legal name', 120],
  ['tradingName', 'Trading name', 120],
  ['streetAddress', 'Street address', 160],
  ['city', 'City', 80],
  ['countyOrState', 'County / state', 80],
  ['postalCode', 'Postal code', 20],
  ['country', 'Country', 80],
];
const OPTIONAL: [keyof ProfileForm, string, number][] = [
  ['tagline', 'Tagline', 120],
  ['locationLabel', 'Location label', 120],
  ['vatNumber', 'VAT number', 40],
  ['registrationNumber', 'Registration number', 40],
  ['invoiceFooterNote', 'Invoice footer note', 500],
  ['bankName', 'Bank name', 120],
  ['bankBranch', 'Bank branch', 120],
  ['bankAccountName', 'Account name', 120],
  ['bankAccountNumber', 'Account number', 40],
];

const orNull = (text: string): string | null => (has(text.trim()) ? text.trim() : null);

/** Only http(s) addresses are kept, so a stored link can never run anything. */
function webAddress(text: string): { url: string | null } | null {
  const trimmed = text.trim();
  if (!has(trimmed)) return { url: null };
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:' ? { url: url.toString() } : null;
  } catch {
    return null;
  }
}

/** The profile form as it is saved, or what is wrong with it. Checked again on the server. */
export function profilePayload(form: ProfileForm): { ok: true; payload: ProfileUpdate } | { ok: false; error: string } {
  for (const [key, label, max] of REQUIRED) {
    const value = form[key].trim();
    if (!has(value)) return { ok: false, error: `${label} is required.` };
    if (value.length > max) return { ok: false, error: `${label} is up to ${String(max)} characters.` };
  }
  for (const [key, label, max] of OPTIONAL) {
    if (form[key].trim().length > max) return { ok: false, error: `${label} is up to ${String(max)} characters.` };
  }
  const email = form.email.trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 160) return { ok: false, error: 'Give a company email address that looks right, like sales@example.com.' };
  const phone = form.phone.trim();
  if (!PHONE.test(phone)) return { ok: false, error: 'Give a mobile number with digits only (spaces, dashes and a leading + are fine).' };
  const tel = form.tel.trim();
  if (has(tel) && !PHONE.test(tel)) return { ok: false, error: 'The landline number should be digits only (spaces, dashes and a leading + are fine).' };
  const kraPin = form.kraPin.trim().toUpperCase();
  if (!KRA_PIN.test(kraPin)) return { ok: false, error: 'A KRA PIN is a letter (A or P), nine digits and a letter, like P051234567Z.' };
  const invoicePrefix = form.invoicePrefix.trim().toUpperCase();
  if (!PREFIX.test(invoicePrefix)) return { ok: false, error: 'The invoice prefix is up to 10 capital letters, digits or dashes, like INV.' };
  const website = webAddress(form.website);
  if (website === null) return { ok: false, error: 'The website should be a full address starting with http:// or https://.' };
  return {
    ok: true,
    payload: {
      legalName: form.legalName.trim(),
      tradingName: form.tradingName.trim(),
      tagline: orNull(form.tagline),
      email,
      phone,
      tel: orNull(form.tel),
      website: website.url,
      streetAddress: form.streetAddress.trim(),
      city: form.city.trim(),
      countyOrState: form.countyOrState.trim(),
      postalCode: form.postalCode.trim(),
      country: form.country.trim(),
      locationLabel: orNull(form.locationLabel),
      kraPin,
      vatNumber: orNull(form.vatNumber),
      registrationNumber: orNull(form.registrationNumber),
      invoicePrefix,
      invoiceFooterNote: orNull(form.invoiceFooterNote),
      bankName: orNull(form.bankName),
      bankBranch: orNull(form.bankBranch),
      bankAccountName: orNull(form.bankAccountName),
      bankAccountNumber: orNull(form.bankAccountNumber),
    },
  };
}

export interface AppearanceForm {
  primaryColor: string;
  accentColor: string;
  desktopColumns: ProductGridDesktopColumns;
}

export const isDesktopColumns = (value: unknown): value is ProductGridDesktopColumns => PRODUCT_GRID_DESKTOP_COLUMNS.some((c) => c === value);

/** The appearance form as it is saved: valid colours (never anything that is not a hex colour) and a known density. */
export function appearancePayload(form: AppearanceForm): { ok: true; payload: AppearanceForm } | { ok: false; error: string } {
  const primaryColor = normalizeHexColor(form.primaryColor, '');
  const accentColor = normalizeHexColor(form.accentColor, '');
  if (primaryColor === '' || accentColor === '') return { ok: false, error: 'Colours are written like #4f46e5.' };
  if (!isDesktopColumns(form.desktopColumns)) return { ok: false, error: 'Choose 2, 3 or 4 columns.' };
  return { ok: true, payload: { primaryColor, accentColor, desktopColumns: form.desktopColumns } };
}

export const MODULE_LABEL_MAX = 80;

/**
 * The module names as they are saved: only the modules that exist, trimmed, empty ones dropped (the built-in
 * name returns), none longer than {@link MODULE_LABEL_MAX}.
 */
export function moduleLabelsPayload(labels: Record<string, string>, knownIds: readonly string[]): { ok: true; payload: Record<string, string> } | { ok: false; error: string } {
  const out: Record<string, string> = {};
  for (const id of knownIds) {
    const value = Object.hasOwn(labels, id) ? labels[id] : undefined;
    const text = typeof value === 'string' ? value.trim() : '';
    if (!has(text)) continue;
    if (text.length > MODULE_LABEL_MAX) return { ok: false, error: `A module name is up to ${String(MODULE_LABEL_MAX)} characters.` };
    out[id] = text;
  }
  return { ok: true, payload: out };
}
