import { has, isRecord } from '@/lib/values';

/**
 * Which parts of the business's identity a printed page carries. Everything starts switched off, so a page looks as it
 * always has until someone chooses more. The same list serves the heading of every report and the top of a till receipt;
 * only where it is stored, and what it starts with, differs.
 */

export const BRAND_ITEMS = [
  'logo',
  'legalName',
  'tagline',
  'address',
  'email',
  'phone',
  'website',
  'kraPin',
] as const;
export type BrandItem = (typeof BRAND_ITEMS)[number];
export type BrandShow = Record<BrandItem, boolean>;

export const BRAND_ITEM_LABELS: Record<BrandItem, string> = {
  logo: 'Logo',
  legalName: 'Registered name',
  tagline: 'Tagline',
  address: 'Address',
  email: 'Email',
  phone: 'Phone numbers',
  website: 'Website',
  kraPin: 'KRA PIN',
};

const noneShown = (): BrandShow => ({
  logo: false,
  legalName: false,
  tagline: false,
  address: false,
  email: false,
  phone: false,
  website: false,
  kraPin: false,
});

/** The heading most businesses want on a report: logo, the registered name, address, email and phone. */
export const STANDARD_LETTERHEAD: BrandShow = {
  ...noneShown(),
  logo: true,
  legalName: true,
  address: true,
  email: true,
  phone: true,
};

export const PLAIN_HEADING: BrandShow = noneShown();

/** What the business has entered about itself, as far as a printed heading needs. */
export interface BrandProfile {
  tradingName: string;
  legalName: string;
  tagline?: string | null;
  streetAddress: string;
  city: string;
  countyOrState: string;
  postalCode: string;
  country: string;
  email: string;
  phone: string;
  tel?: string | null;
  website?: string | null;
  kraPin: string;
  logoUrl?: string | null;
}

/** The identity a page prints, already cut down to what was chosen. Empty parts are null, never blank text. */
export interface BrandBlock {
  name: string;
  legalName: string | null;
  tagline: string | null;
  address: string | null;
  /** Phone numbers, email and website, each as its own short piece, in that order. */
  contacts: string[];
  kraPin: string | null;
  logoUrl: string | null;
}

const clean = (value: string | null | undefined): string => (value ?? '').trim();

/** The address a browser loads the logo from. Logos saved under the old upload folder are served by the logo route now. */
function logoSrc(logoUrl: string): string {
  const legacy = /^\/uploads\/company\/(logo-[A-Za-z0-9._-]+)$/.exec(logoUrl);
  return legacy?.[1] === undefined ? logoUrl : `/api/company/logo/${encodeURIComponent(legacy[1])}`;
}

/** The name a page is headed with: the trading name, or the registered name when there is none. */
export function brandName(profile: Pick<BrandProfile, 'tradingName' | 'legalName'>): string {
  return has(clean(profile.tradingName)) ? clean(profile.tradingName) : clean(profile.legalName);
}

export function brandBlock(profile: BrandProfile, show: BrandShow): BrandBlock {
  const name = brandName(profile);
  const legal = clean(profile.legalName);
  const address = [
    clean(profile.streetAddress),
    clean(profile.city),
    [clean(profile.countyOrState), clean(profile.postalCode)].filter(has).join(' '),
    clean(profile.country),
  ]
    .filter(has)
    .join(', ');
  const numbers = [...new Set([clean(profile.phone), clean(profile.tel)].filter(has))];
  const contacts: string[] = [];
  if (show.phone && numbers.length > 0) contacts.push(`Tel ${numbers.join(' / ')}`);
  if (show.email && has(clean(profile.email))) contacts.push(clean(profile.email));
  if (show.website && has(clean(profile.website))) contacts.push(clean(profile.website));
  return {
    name,
    legalName: show.legalName && has(legal) && legal !== name ? legal : null,
    tagline: show.tagline && has(clean(profile.tagline)) ? clean(profile.tagline) : null,
    address: show.address && has(address) ? address : null,
    contacts,
    kraPin: show.kraPin && has(clean(profile.kraPin)) ? `KRA PIN ${clean(profile.kraPin)}` : null,
    logoUrl: show.logo && has(clean(profile.logoUrl)) ? logoSrc(clean(profile.logoUrl)) : null,
  };
}

// ── What is stored ────────────────────────────────────────────────────────

/** Settings for the heading of report downloads: one for every report, and optionally one for a whole module of reports. */
export interface ReportPrintSettings {
  general: BrandShow;
  /** Only modules that have their own heading are listed; any other uses `general`. */
  modules: Record<string, BrandShow>;
}

/** Settings for the top of a printed record, by record (a cash sale receipt, for now). */
export const PRINTED_RECORDS = ['cash_sale'] as const;
export type PrintedRecord = (typeof PRINTED_RECORDS)[number];
export type RecordPrintSettings = Record<PrintedRecord, BrandShow>;

export const DEFAULT_REPORT_PRINT: ReportPrintSettings = { general: PLAIN_HEADING, modules: {} };
export const DEFAULT_RECORD_PRINT: RecordPrintSettings = { cash_sale: PLAIN_HEADING };

/** Reads a stored set of choices: a part that is missing or not a true/false answer keeps `fallback`'s value. */
export function readShow(raw: unknown, fallback: BrandShow = PLAIN_HEADING): BrandShow {
  const source = isRecord(raw) ? raw : {};
  const out = noneShown();
  for (const item of BRAND_ITEMS) {
    const value = source[item];
    out[item] = typeof value === 'boolean' ? value : fallback[item];
  }
  return out;
}

/** Reads the stored report heading settings. Modules the reports do not have are dropped. */
export function resolveReportPrint(raw: unknown, knownModules: readonly string[]): ReportPrintSettings {
  const source = isRecord(raw) ? raw : {};
  const stored = isRecord(source.modules) ? source.modules : {};
  const modules: Record<string, BrandShow> = {};
  for (const code of knownModules) {
    if (isRecord(stored[code])) modules[code] = readShow(stored[code]);
  }
  return { general: readShow(source.general), modules };
}

export function resolveRecordPrint(raw: unknown): RecordPrintSettings {
  const source = isRecord(raw) ? raw : {};
  return { cash_sale: readShow(source.cash_sale) };
}

/** The heading choices that apply to a report of this module: its own when it has them, otherwise the general ones. */
export function headingFor(settings: ReportPrintSettings, module: string): BrandShow {
  return settings.modules[module] ?? settings.general;
}

/** Checks a set of choices sent from a screen. The browser is never trusted: every part must be a true or false answer. */
export function showProblem(raw: unknown): string | null {
  if (!isRecord(raw)) return 'The choices are not in a valid format.';
  for (const item of BRAND_ITEMS) {
    if (typeof raw[item] !== 'boolean') return `Choose whether to show: ${BRAND_ITEM_LABELS[item].toLowerCase()}.`;
  }
  return null;
}
