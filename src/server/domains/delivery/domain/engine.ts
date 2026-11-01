import { has } from '@/lib/values';
import { localClock, ruleHolds, type LocalClock } from './time';
import type { ChargePolicyDef, ChargeQuote, ChargeRequest, ChargeStep, Leg, RefusalReason, StepKind } from './types';

/** Amounts are kept to four decimals while they are worked out, so sums do not drift. */
const r4 = (value: number): number => Math.round((value + Number.EPSILON) * 1e4) / 1e4;

const shown = (currency: string, value: number): string => `${currency} ${Number.isInteger(value) ? String(value) : value.toFixed(2)}`;

const km = (value: number): string => `${String(Math.round(value * 100) / 100)} km`;

function refuse(reason: RefusalReason, message: string): ChargeQuote {
  return { ok: false, reason, message };
}

const finite = (n: number): boolean => Number.isFinite(n) && n >= 0;

/** The leg that is charged for, by the policy's distance basis. */
export function tripFor(basis: ChargePolicyDef['distanceBasis'], out: Leg, back: Leg | null): Leg {
  if (basis === 'one_way') return out;
  if (back === null) return basis === 'round_trip' ? roundTrip(out, null) : out;
  if (basis === 'longer_leg') return back.km > out.km ? back : out;
  return roundTrip(out, back);
}

/** There and back: the legs added, or the outward leg doubled when the way back is not known. */
function roundTrip(out: Leg, back: Leg | null): Leg {
  const other = back ?? out;
  const minutes = out.minutes !== null && other.minutes !== null ? out.minutes + other.minutes : null;
  return { km: r4(out.km + other.km), minutes };
}

/** Where a fee applies, in words. */
function rowWhere(method: ChargePolicyDef['method'], zoneId: string | null, zoneName: string | null | undefined): string {
  if (zoneId !== null) return `Delivery to ${has(zoneName) ? zoneName : 'the zone'}`;
  return method === 'flat' ? 'Delivery' : 'Delivery to any other zone';
}

/** Which weights a fee is for, in words. */
function rowBand(row: { fromKg: number; toKg: number | null }): string {
  if (row.toKg !== null) return ` for ${String(row.fromKg)} to ${String(row.toKg)} kg`;
  return row.fromKg > 0 ? ` over ${String(row.fromKg)} kg` : '';
}

/**
 * The delivery charge for a request under a policy, with the steps that explain it. Pure: the same policy and request always give the
 * same answer. When the charge cannot be worked out it says why, in words; it never falls back to a default price.
 */
export function quoteCharge(policy: ChargePolicyDef, request: ChargeRequest): ChargeQuote {
  const c = policy.currency;
  if (!(request.at instanceof Date) || Number.isNaN(request.at.getTime()) || !finite(request.orderValue) || !finite(request.weightKg)) return refuse('bad_input', 'The order value, weight or time is not valid.');
  for (const leg of [request.out, request.back]) if (leg !== null && (!finite(leg.km) || (leg.minutes !== null && !finite(leg.minutes)))) return refuse('bad_input', 'The distance is not valid.');
  if (policy.maxWeightKg !== null && request.weightKg > policy.maxWeightKg) return refuse('too_heavy', `This order weighs ${String(request.weightKg)} kg, and this delivery takes at most ${String(policy.maxWeightKg)} kg.`);

  const steps: ChargeStep[] = [];
  let running = 0;
  const add = (kind: StepKind, label: string, amount: number): void => {
    const delta = r4(amount);
    running = r4(running + delta);
    steps.push({ kind, label, amount: delta, running });
  };
  let tripKm: number | null = null;
  let tripMinutes: number | null = null;

  if (policy.method === 'distance') {
    if (request.out === null) return refuse('no_distance', 'The distance is not known. A map pin or an address that can be found on the map is needed.');
    if (policy.maxRangeKm !== null && request.out.km > policy.maxRangeKm) return refuse('out_of_range', `This address is ${km(request.out.km)} away, and this delivery goes up to ${km(policy.maxRangeKm)}.`);
    const trip = tripFor(policy.distanceBasis, request.out, request.back);
    tripKm = trip.km;
    tripMinutes = trip.minutes;
    const band = policy.bands.find((b) => trip.km >= b.fromKm && (b.toKm === null || trip.km < b.toKm));
    if (band === undefined) return refuse('no_rate', `No distance band covers ${km(trip.km)}.`);
    const span = band.toKm === null ? `from ${km(band.fromKm)}` : `${km(band.fromKm)} to ${km(band.toKm)}`;
    add('base', `Base fee for ${span}`, band.baseFee);
    if (band.perKm > 0 && trip.km > band.fromKm) add('base', `${shown(c, band.perKm)} a km for ${km(trip.km - band.fromKm)}`, band.perKm * (trip.km - band.fromKm));
    if (policy.perMinute > 0 && trip.minutes !== null) add('time', `${shown(c, policy.perMinute)} a minute for ${String(Math.round(trip.minutes))} minutes`, policy.perMinute * trip.minutes);
    if (policy.includedKg !== null && policy.perExtraKg > 0 && request.weightKg > policy.includedKg) {
      const started = Math.ceil(request.weightKg - policy.includedKg - 1e-9);
      add('weight', `${shown(c, policy.perExtraKg)} for each of ${String(started)} kg over ${String(policy.includedKg)} kg`, policy.perExtraKg * started);
    }
  } else {
    const zoneRows = request.zoneId === null || policy.method === 'flat' ? [] : policy.rates.filter((r) => r.zoneId === request.zoneId);
    const defaultRows = policy.rates.filter((r) => r.zoneId === null);
    if (policy.method === 'zone_rate' && request.zoneId === null && defaultRows.length === 0) return refuse('no_zone', 'This address is not in any delivery zone.');
    const inBand = (r: { fromKg: number; toKg: number | null }): boolean => request.weightKg >= r.fromKg && (r.toKg === null || request.weightKg < r.toKg);
    const row = zoneRows.find(inBand) ?? defaultRows.find(inBand);
    if (row === undefined) return refuse('no_rate', `No delivery fee is set for ${String(request.weightKg)} kg${has(request.zoneName) ? ` to ${request.zoneName}` : ''}.`);
    add('base', `${rowWhere(policy.method, row.zoneId, request.zoneName)}${rowBand(row)}`, row.fee);
    if (row.toKg === null && row.perExtraKg > 0 && request.weightKg > row.fromKg) {
      const started = Math.ceil(request.weightKg - row.fromKg - 1e-9);
      add('weight', `${shown(c, row.perExtraKg)} for each of ${String(started)} kg over ${String(row.fromKg)} kg`, row.perExtraKg * started);
    }
  }

  if (policy.surcharges.length > 0) {
    let clock: LocalClock;
    try {
      clock = localClock(request.at, request.timeZone);
    } catch {
      return refuse('bad_time_zone', `The company time zone "${request.timeZone}" is not valid.`);
    }
    const subtotal = running;
    for (const rule of policy.surcharges) {
      if (!ruleHolds(rule, clock)) continue;
      add('surcharge', rule.kind === 'fixed' ? rule.label : `${rule.label} (${String(rule.amount)}%)`, rule.kind === 'fixed' ? rule.amount : (subtotal * rule.amount) / 100);
    }
  }

  if (policy.minCharge !== null && running < policy.minCharge) add('minimum', `Raised to the minimum charge of ${shown(c, policy.minCharge)}`, policy.minCharge - running);
  if (policy.maxCharge !== null && running > policy.maxCharge) add('maximum', `Held to the maximum charge of ${shown(c, policy.maxCharge)}`, policy.maxCharge - running);

  const tier = policy.tiers.filter((t) => request.orderValue >= t.minOrderValue).sort((a, b) => b.minOrderValue - a.minOrderValue).at(0);
  if (tier !== undefined && tier.percentOff > 0 && running > 0) add('order_value', tier.percentOff >= 100 ? `Free delivery on orders of ${shown(c, tier.minOrderValue)} or more` : `${String(tier.percentOff)}% off for orders of ${shown(c, tier.minOrderValue)} or more`, -(running * tier.percentOff) / 100);

  if (policy.roundTo > 0) {
    const units = running / policy.roundTo;
    const target = r4((policy.roundMode === 'up' ? Math.ceil(units - 1e-9) : Math.round(units + 1e-9)) * policy.roundTo);
    if (target !== running) add('rounding', `Rounded ${policy.roundMode === 'up' ? 'up ' : ''}to the nearest ${shown(c, policy.roundTo)}`, target - running);
  }

  return { ok: true, amount: Math.max(0, running), currency: c, steps, basis: { method: policy.method, policyId: policy.id, policyVersion: policy.version, km: tripKm, minutes: tripMinutes, zoneId: request.zoneId, approximate: policy.method === 'distance' && request.distanceApproximate } };
}
