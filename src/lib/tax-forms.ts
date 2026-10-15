import type { TaxCategory, TaxType } from '@/types/index';
import { has } from '@/lib/values';

export const TAX_TYPES: readonly { id: TaxType; label: string }[] = [
  { id: 'vat', label: 'Value Added Tax (VAT)' },
  { id: 'sales_tax', label: 'Sales Tax' },
  { id: 'gst', label: 'Goods and Services Tax (GST)' },
  { id: 'excise', label: 'Excise Duty' },
  { id: 'digital_service', label: 'Digital Services Tax (DST)' },
  { id: 'exempt', label: 'Zero Rated / Exempt' },
  { id: 'custom', label: 'Custom' },
];

export type PricingModel = 'inclusive' | 'exclusive';

export const PRICING_MODELS: readonly { id: PricingModel; label: string }[] = [
  { id: 'inclusive', label: 'Price Inclusive' },
  { id: 'exclusive', label: 'Price Exclusive' },
];

export const labelOfTaxType = (type: string): string => TAX_TYPES.find((t) => t.id === type)?.label ?? type;
export const isTaxType = (value: string | undefined): value is TaxType => TAX_TYPES.some((t) => t.id === value);
export const isPricingModel = (value: string | undefined): value is PricingModel => value === 'inclusive' || value === 'exclusive';

export interface TaxForm {
  name: string;
  code: string;
  rate: string;
  timsCode: string;
  etimsCode: string;
  type: TaxType;
  countryCode: string;
  countryName: string;
  description: string;
  isInclusive: boolean;
  isDefault: boolean;
  isActive: boolean;
}

/** The form for a new tax rule, or filled from one being edited. (The server makes the very first rule the default.) */
export function taxFormFrom(tax: TaxCategory | null): TaxForm {
  if (tax === null) {
    return { name: '', code: '', rate: '', timsCode: '', etimsCode: '', type: 'vat', countryCode: '', countryName: '', description: '', isInclusive: true, isDefault: false, isActive: true };
  }
  return {
    name: tax.name,
    code: tax.code,
    rate: String(tax.rate),
    timsCode: tax.timsCode,
    etimsCode: tax.etimsCode,
    type: tax.type,
    countryCode: tax.countryCode,
    countryName: tax.countryName,
    description: tax.description,
    isInclusive: tax.isInclusive,
    isDefault: tax.isDefault,
    isActive: tax.isActive,
  };
}

/** The tax form as it is sent, or what is wrong with it. */
export function taxPayload(form: TaxForm):
  | { ok: true; payload: Omit<TaxCategory, 'id' | 'createdAt' | 'updatedAt' | 'productCount'> }
  | { ok: false; error: string } {
  if (!has(form.name.trim())) return { ok: false, error: 'Tax category name is required.' };
  if (!has(form.code.trim())) return { ok: false, error: 'Give the rule a code; each rule has its own.' };
  const rate = form.rate.trim() === '' ? Number.NaN : Number(form.rate);
  if (!Number.isFinite(rate) || rate < 0) return { ok: false, error: 'Tax rate must be 0% or greater.' };
  return {
    ok: true,
    payload: {
      name: form.name.trim(),
      code: form.code.trim(),
      rate,
      timsCode: form.timsCode,
      etimsCode: form.etimsCode,
      type: form.type,
      countryCode: form.countryCode.trim().toUpperCase(),
      countryName: form.countryName.trim(),
      description: form.description.trim(),
      isInclusive: form.isInclusive,
      isDefault: form.isDefault,
      isActive: form.isActive,
    },
  };
}

export interface TaxBreakdown {
  net: number;
  tax: number;
  gross: number;
}

/** What an amount comes to under a rule: inclusive prices hold the tax inside, exclusive ones add it on top. */
export function breakdown(amount: number, ratePercent: number, inclusive: boolean): TaxBreakdown {
  const value = Number.isFinite(amount) ? amount : 0;
  const rate = ratePercent / 100;
  if (inclusive) {
    const net = rate > 0 ? value / (1 + rate) : value;
    return { net, tax: value - net, gross: value };
  }
  const tax = value * rate;
  return { net: value, tax, gross: value + tax };
}

export const taxLabel = (t: Pick<TaxCategory, 'name' | 'rate' | 'isInclusive'>): string => `${t.name} (${String(t.rate)}%) - ${t.isInclusive ? 'Inclusive' : 'Exclusive'}`;
