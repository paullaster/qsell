import type { CustomerProfileRow, CustomerRow, DimensionCodesProjection } from '@/server/db/drizzle/schema';
import { accountTypeOf, blockOf, type CustomerAccountType, type CustomerBlock } from '@/lib/customer-forms';
import { metaValue } from '@/lib/receipt-form';
import type { Choice } from '@/lib/payment-options';
import { has } from '@/lib/values';

/** A dimension a customer or profile can carry a default for. */
export interface CardField {
  fieldName: string;
  dimensionId: string;
  dimensionCode: string;
  kind: 'global' | 'shortcut';
}

export function money(value: string | number | null | undefined): string {
  const n = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00';
}

const fieldNumber = (fieldName: string): string | null => /^(?:global|shortcut)Dimension(\d+)Code$/.exec(fieldName)?.[1] ?? null;

/** The codes chosen for each dimension field, from what is stored. */
export function projectionToSelected(codes: DimensionCodesProjection | null | undefined, fields: CardField[]): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const field of fields) {
    const n = fieldNumber(field.fieldName);
    if (n === null) continue;
    selected[field.fieldName] = (field.kind === 'global' ? codes?.global[n] : codes?.shortcut[n]) ?? '';
  }
  return selected;
}

/** What is stored, from the codes chosen: empty choices are left out. */
export function selectedToProjection(selected: Record<string, string>, fields: CardField[]): DimensionCodesProjection {
  const global: Record<string, string> = {};
  const shortcut: Record<string, string> = {};
  for (const field of fields) {
    const code = selected[field.fieldName];
    const n = fieldNumber(field.fieldName);
    if (!has(code) || n === null) continue;
    if (field.kind === 'global') global[n] = code;
    else shortcut[n] = code;
  }
  return { global, shortcut };
}

export interface CardForm {
  profileId: string;
  profileLabel: string;
  name: string;
  email: string;
  phone: string;
  street: string;
  city: string;
  countyOrState: string;
  postalCode: string;
  country: string;
  accountType: CustomerAccountType;
  creditLimit: string;
  paymentTermDays: string;
  blocked: CustomerBlock;
  transmitInvoicesToKra: boolean;
  buyerKraPin: string;
  notes: string;
  isActive: boolean;
  dimensions: Record<string, string>;
}

export const emptyCard = (fields: CardField[]): CardForm => ({
  profileId: '', profileLabel: '', name: '', email: '', phone: '', street: '', city: '', countyOrState: '', postalCode: '', country: '',
  accountType: 'cash', creditLimit: '0', paymentTermDays: '0', blocked: 'none', transmitInvoicesToKra: true, buyerKraPin: '', notes: '', isActive: true,
  dimensions: projectionToSelected(undefined, fields),
});

export const cardFrom = (row: CustomerRow, profileLabel: string, fields: CardField[]): CardForm => ({
  profileId: row.profileId ?? '', profileLabel,
  name: row.name, email: row.email ?? '', phone: row.phone ?? '', street: row.street ?? '', city: row.city ?? '', countyOrState: row.countyOrState ?? '', postalCode: row.postalCode ?? '', country: row.country ?? '',
  accountType: accountTypeOf(row.accountType), creditLimit: row.creditLimit, paymentTermDays: String(row.paymentTermDays), blocked: blockOf(row.blocked),
  transmitInvoicesToKra: row.transmitInvoicesToKra, buyerKraPin: row.buyerKraPin ?? '', notes: row.notes ?? '', isActive: row.isActive,
  dimensions: projectionToSelected(row.dimensionCodes, fields),
});

const parseCodes = (text: string): DimensionCodesProjection | null => {
  try {
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== 'object' || raw === null) return null;
    const pick = (value: unknown): Record<string, string> =>
      typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === 'string')) : {};
    const r = raw as { global?: unknown; shortcut?: unknown };
    return { global: pick(r.global), shortcut: pick(r.shortcut) };
  } catch {
    return null;
  }
};

/** A form after a profile is chosen: its account type, terms, KRA setting and default dimensions come along. */
export function withProfile(form: CardForm, profile: Choice | null, fields: CardField[]): CardForm {
  if (profile === null) return { ...form, profileId: '', profileLabel: '' };
  const accountType = accountTypeOf(metaValue(profile.meta, 'accountType'));
  const cash = accountType === 'cash';
  const codes = parseCodes(metaValue(profile.meta, 'dimensions'));
  const hasCodes = codes !== null && Object.keys(codes.global).length + Object.keys(codes.shortcut).length > 0;
  return {
    ...form,
    profileId: profile.id,
    profileLabel: profile.label,
    accountType,
    creditLimit: cash ? '0' : metaValue(profile.meta, 'creditLimit'),
    paymentTermDays: cash ? '0' : metaValue(profile.meta, 'paymentTermDays'),
    transmitInvoicesToKra: metaValue(profile.meta, 'transmit') === '1',
    dimensions: hasCodes ? projectionToSelected(codes, fields) : form.dimensions,
  };
}

export interface ProfileCard {
  code: string;
  name: string;
  description: string;
  accountType: CustomerAccountType;
  creditLimit: string;
  paymentTermDays: string;
  transmitInvoicesToKra: boolean;
  isActive: boolean;
  dimensions: Record<string, string>;
}

export const emptyProfileCard = (fields: CardField[]): ProfileCard => ({
  code: '', name: '', description: '', accountType: 'cash', creditLimit: '0', paymentTermDays: '0', transmitInvoicesToKra: true, isActive: true, dimensions: projectionToSelected(undefined, fields),
});

export const profileCardFrom = (row: CustomerProfileRow, fields: CardField[]): ProfileCard => ({
  code: row.code, name: row.name, description: row.description ?? '', accountType: accountTypeOf(row.accountType), creditLimit: row.creditLimit,
  paymentTermDays: String(row.paymentTermDays), transmitInvoicesToKra: row.transmitInvoicesToKra, isActive: row.isActive, dimensions: projectionToSelected(row.dimensionCodes, fields),
});

/** A form after the account type changes: cash has no limit or terms; credit brings a default term back. */
export function withAccountType<T extends { accountType: CustomerAccountType; creditLimit: string; paymentTermDays: string }>(form: T, accountType: CustomerAccountType): T {
  return {
    ...form,
    accountType,
    creditLimit: accountType === 'cash' ? '0' : form.creditLimit,
    paymentTermDays: accountType === 'cash' ? '0' : form.paymentTermDays,
  };
}

/** A stored profile as the picker offers it, so choosing it fills the card the same way. */
export const profileChoice = (p: CustomerProfileRow): Choice => ({
  id: p.id,
  label: `${p.code} — ${p.name}`,
  meta: { accountType: p.accountType, creditLimit: p.creditLimit, paymentTermDays: String(p.paymentTermDays), transmit: p.transmitInvoicesToKra ? '1' : '', dimensions: JSON.stringify(p.dimensionCodes) },
});
