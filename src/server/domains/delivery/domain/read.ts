import { validateScopes } from '@/server/domains/pricing/domain/rules';
import type { Scopes } from '@/server/domains/pricing/domain/types';
import { CHARGE_METHODS, DISTANCE_BASES, ROUND_MODES, type ChargeMethod, type DistanceBand, type DistanceBasis, type RateRow, type RoundMode, type Surcharge, type ValueTier } from './types';
import { clockMinutes } from '@/lib/clock-time';
import { DEFAULT_BUSINESS_TIMEZONE } from '@/server/kernel/numbering/business-date';
import { isDateOnly, nextDay, startOfLocalDay } from './time';
import { LIMITS } from './validate';

/** A policy as a person writes it: everything but its code and version. */
export interface PolicyInput {
  name: string;
  description: string | null;
  method: ChargeMethod;
  currency: string;
  priority: number;
  validFrom: Date | null;
  validTo: Date | null;
  scopes: Scopes;
  distanceBasis: DistanceBasis;
  maxRangeKm: number | null;
  perMinute: number;
  includedKg: number | null;
  perExtraKg: number;
  maxWeightKg: number | null;
  minCharge: number | null;
  maxCharge: number | null;
  roundTo: number;
  roundMode: RoundMode;
  /** The tax on the charge, in percent, and whether the amount the policy works out already includes it. */
  taxRate: number;
  taxInclusive: boolean;
  rates: RateRow[];
  bands: DistanceBand[];
  tiers: ValueTier[];
  surcharges: Surcharge[];
}

type Read<T> = { ok: true; value: T } | { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const blank = (v: unknown): boolean => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/** A number written as a number or as text; NaN for anything else. */
function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v.trim());
  return Number.NaN;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class Bad extends Error {}
const fail = (message: string): never => {
  throw new Bad(message);
};
const need = (v: unknown, what: string): number => {
  const n = num(v);
  return Number.isFinite(n) ? n : fail(`${what} must be a number.`);
};
const optional = (v: unknown, what: string): number | null => (blank(v) ? null : need(v, what));
const list = (v: unknown, what: string, max: number): unknown[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return fail(`${what} must be a list.`);
  return v.length > max ? fail(`Use at most ${String(max)} ${what}.`) : (v as unknown[]);
};
const row = (v: unknown, what: string): Record<string, unknown> => (isObject(v) ? v : fail(`${what} is not valid.`));

/** A time of day as minutes after midnight, from minutes or from text such as 22:00. */
function minuteOf(v: unknown, what: string): number | null {
  if (blank(v)) return null;
  if (typeof v === 'string' && v.includes(':')) {
    const minutes = clockMinutes(v);
    return Number.isNaN(minutes) ? fail(`${what} must be a time such as 22:00.`) : minutes;
  }
  const n = num(v);
  return Number.isFinite(n) ? n : fail(`${what} must be a time such as 22:00.`);
}

function zoneOf(v: unknown, where: string): string | null {
  if (blank(v)) return null;
  return typeof v === 'string' && UUID.test(v) ? v : fail(`${where}: that zone is not valid.`);
}

function seasonDate(v: unknown, where: string): string | null {
  if (blank(v)) return null;
  return typeof v === 'string' ? v.trim() : fail(`${where}: a season date is not valid.`);
}

function kindOf(v: unknown, where: string): 'fixed' | 'percent' {
  if (v === 'percent' || v === 'fixed') return v;
  return fail(`${where}: choose a fixed amount or a percentage.`);
}

/**
 * A date as written. A plain day (2026-11-01) is the start of that day in the business's time zone, or with `lastDay` the start of the
 * day after it (so "the last day" includes the whole day). Anything else must be a full date and time.
 */
function date(v: unknown, what: string, lastDay = false): Date | null {
  if (blank(v)) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? fail(`${what} is not a date.`) : v;
  const text = String(v).trim();
  if (isDateOnly(text)) return startOfLocalDay(lastDay ? nextDay(text) : text, DEFAULT_BUSINESS_TIMEZONE);
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? fail(`${what} is not a date.`) : d;
}

/** The tax rate in percent: nothing is 0; otherwise a number from 0 to 100 with at most two decimals. */
function taxRateOf(v: unknown): number {
  if (blank(v)) return 0;
  const n = num(v);
  if (!Number.isFinite(n) || n < 0 || n > 100 || Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) return fail('The tax rate is a percentage from 0 to 100, with up to two decimals.');
  return n;
}

/** A policy from what the browser sent, or the first thing wrong with it. It checks shape and size; `validatePolicy` checks that it is sound. */
export function readPolicyInput(raw: unknown): Read<PolicyInput> {
  try {
    const i = row(raw, 'The policy');
    const name = typeof i.name === 'string' ? i.name.trim() : '';
    if (name === '') fail('Give the policy a name.');
    if (name.length > 80) fail('A policy name is at most 80 characters.');
    const method = i.method;
    if (typeof method !== 'string' || !(CHARGE_METHODS as readonly string[]).includes(method)) fail('Choose how the charge is worked out.');
    const basis = blank(i.distanceBasis) ? 'one_way' : i.distanceBasis;
    if (typeof basis !== 'string' || !(DISTANCE_BASES as readonly string[]).includes(basis)) fail('Choose how the distance is measured.');
    const mode = blank(i.roundMode) ? 'nearest' : i.roundMode;
    if (typeof mode !== 'string' || !(ROUND_MODES as readonly string[]).includes(mode)) fail('Choose how the charge is rounded.');
    const currency = typeof i.currency === 'string' ? i.currency.trim().toUpperCase() : '';
    const scopes = blank(i.scopes) ? {} : (i.scopes as Scopes);
    if (!isObject(scopes)) fail('Who the policy is for is not valid.');
    const scopeIssues = validateScopes(scopes);
    if (scopeIssues.length > 0) fail(scopeIssues[0]?.message ?? 'Who the policy is for is not valid.');
    const description = typeof i.description === 'string' ? i.description.trim().slice(0, 300) : '';

    const rates: RateRow[] = list(i.rates, 'fees', LIMITS.rates).map((r, n) => {
      const o = row(r, `Fee ${String(n + 1)}`);
      const zoneId = zoneOf(o.zoneId, `Fee ${String(n + 1)}`);
      return { zoneId, fromKg: blank(o.fromKg) ? 0 : need(o.fromKg, `Fee ${String(n + 1)}: the starting weight`), toKg: optional(o.toKg, `Fee ${String(n + 1)}: the ending weight`), fee: need(o.fee, `Fee ${String(n + 1)}: the fee`), perExtraKg: blank(o.perExtraKg) ? 0 : need(o.perExtraKg, `Fee ${String(n + 1)}: the fee for each extra kilogram`) };
    });
    const bands: DistanceBand[] = list(i.bands, 'distance bands', LIMITS.bands).map((b, n) => {
      const o = row(b, `Band ${String(n + 1)}`);
      return { fromKm: blank(o.fromKm) ? 0 : need(o.fromKm, `Band ${String(n + 1)}: the start`), toKm: optional(o.toKm, `Band ${String(n + 1)}: the end`), baseFee: need(o.baseFee, `Band ${String(n + 1)}: the base fee`), perKm: blank(o.perKm) ? 0 : need(o.perKm, `Band ${String(n + 1)}: the rate per kilometre`) };
    });
    const tiers: ValueTier[] = list(i.tiers, 'order-value steps', LIMITS.tiers).map((t, n) => {
      const o = row(t, `Step ${String(n + 1)}`);
      return { minOrderValue: need(o.minOrderValue, `Step ${String(n + 1)}: the order value`), percentOff: need(o.percentOff, `Step ${String(n + 1)}: the percentage off`) };
    });
    const surcharges: Surcharge[] = list(i.surcharges, 'extra charges', LIMITS.surcharges).map((s, n) => {
      const o = row(s, `Extra charge ${String(n + 1)}`);
      const days = blank(o.days) ? null : list(o.days, 'days', 7).map((d) => need(d, `Extra charge ${String(n + 1)}: a day`));
      const text = (v: unknown): string | null => seasonDate(v, `Extra charge ${String(n + 1)}`);
      return {
        label: typeof o.label === 'string' ? o.label.trim() : '',
        kind: kindOf(o.kind, `Extra charge ${String(n + 1)}`),
        amount: need(o.amount, `Extra charge ${String(n + 1)}: the amount`),
        days,
        fromMinute: minuteOf(o.fromMinute, `Extra charge ${String(n + 1)}: the start of the hours`),
        toMinute: minuteOf(o.toMinute, `Extra charge ${String(n + 1)}: the end of the hours`),
        dateFrom: text(o.dateFrom),
        dateTo: text(o.dateTo),
      };
    });

    return {
      ok: true,
      value: {
        name,
        description: description === '' ? null : description,
        method: method as ChargeMethod,
        currency,
        priority: blank(i.priority) ? 0 : Math.trunc(need(i.priority, 'The priority')),
        validFrom: date(i.validFrom, 'The first day'),
        validTo: date(i.validTo, 'The last day', true),
        scopes,
        distanceBasis: basis as DistanceBasis,
        maxRangeKm: optional(i.maxRangeKm, 'The furthest distance'),
        perMinute: blank(i.perMinute) ? 0 : need(i.perMinute, 'The rate per minute'),
        includedKg: optional(i.includedKg, 'The free weight'),
        perExtraKg: blank(i.perExtraKg) ? 0 : need(i.perExtraKg, 'The fee for each extra kilogram'),
        maxWeightKg: optional(i.maxWeightKg, 'The heaviest order'),
        minCharge: optional(i.minCharge, 'The minimum charge'),
        maxCharge: optional(i.maxCharge, 'The maximum charge'),
        roundTo: blank(i.roundTo) ? 0 : need(i.roundTo, 'The rounding unit'),
        roundMode: mode as RoundMode,
        taxRate: taxRateOf(i.taxRate),
        taxInclusive: i.taxInclusive === true || i.taxInclusive === 'true',
        rates,
        bands,
        tiers,
        surcharges,
      },
    };
  } catch (error) {
    if (error instanceof Bad) return { ok: false, error: error.message };
    throw error;
  }
}
