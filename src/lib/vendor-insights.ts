/** Pure measures for the vendor reports (design doc §12.8, §17.4): rates, scores and the thresholds the watch list uses. */

export interface WatchSettings {
  /** Invoices with the same vendor and total, dated within this many days of each other, are flagged. */
  duplicateWindowDays: number;
  /** A payment to a vendor created within this many days is flagged when it is at least `newVendorAmountCents`. */
  newVendorDays: number;
  newVendorAmountCents: number;
}

export const WATCH_DEFAULTS: WatchSettings = { duplicateWindowDays: 7, newVendorDays: 30, newVendorAmountCents: 10_000_000 };

/** A share as a whole-or-one-decimal percentage, or null when nothing was measured (never 0% of nothing). */
export function percent(part: number, whole: number): number | null {
  if (!(whole > 0) || part < 0) return null;
  return Math.round((Math.min(part, whole) / whole) * 1000) / 10;
}

export function showPercent(value: number | null): string {
  return value === null ? 'Not measured' : `${value.toFixed(1)}%`;
}

export const isDay = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

/** The range a report covers; a missing or invalid end defaults to today and the start to a year before. */
export function reportRange(from: unknown, to: unknown, today: string): { from: string; to: string } {
  const end = isDay(to) ? to : today;
  const startDefault = new Date(`${end}T00:00:00Z`);
  startDefault.setUTCFullYear(startDefault.getUTCFullYear() - 1);
  const start = isDay(from) ? from : startDefault.toISOString().slice(0, 10);
  return start <= end ? { from: start, to: end } : { from: end, to: start };
}

/** Whole days between two dates, `later` minus `earlier`. */
export function daysBetween(earlier: string, later: string): number {
  return Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000);
}

export function checkWatchSettings(s: Partial<WatchSettings>): WatchSettings {
  const whole = (v: unknown, fallback: number, max: number): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : fallback);
  return {
    duplicateWindowDays: whole(s.duplicateWindowDays, WATCH_DEFAULTS.duplicateWindowDays, 365),
    newVendorDays: whole(s.newVendorDays, WATCH_DEFAULTS.newVendorDays, 3650),
    newVendorAmountCents: whole(s.newVendorAmountCents, WATCH_DEFAULTS.newVendorAmountCents, 1_000_000_000_000),
  };
}

/** Why a payment deserves a second look, in plain words; empty when it does not. */
export function paymentFlags(input: { amountCents: number; vendorAgeDays: number; sharesBankAccount: boolean }, settings: Pick<WatchSettings, 'newVendorDays' | 'newVendorAmountCents'>): string[] {
  const reasons: string[] = [];
  if (settings.newVendorAmountCents > 0 && input.amountCents >= settings.newVendorAmountCents && input.vendorAgeDays <= settings.newVendorDays) reasons.push(`a large payment to a vendor added ${String(Math.max(0, input.vendorAgeDays))} days ago`);
  if (input.sharesBankAccount) reasons.push('the bank account is also used by another vendor');
  return reasons;
}

/** Amount text like 100000 or 2500.50 in cents, or null when it is not an amount. */
export function amountCentsOrNull(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(t)) return null;
  const [whole = '0', frac = ''] = t.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}
