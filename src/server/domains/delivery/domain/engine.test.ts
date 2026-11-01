import { describe, expect, it } from 'vitest';
import { quoteCharge, tripFor } from './engine';
import { inDateRange, localClock, ruleHolds } from './time';
import type { ChargePolicyDef, ChargeRequest, Surcharge } from './types';

const policy = (over: Partial<ChargePolicyDef> = {}): ChargePolicyDef => ({
  id: 'p1',
  code: 'STD',
  name: 'Standard',
  version: 1,
  method: 'flat',
  currency: 'KES',
  distanceBasis: 'one_way',
  maxRangeKm: null,
  perMinute: 0,
  includedKg: null,
  perExtraKg: 0,
  maxWeightKg: null,
  minCharge: null,
  maxCharge: null,
  roundTo: 0,
  roundMode: 'nearest',
  rates: [],
  bands: [],
  tiers: [],
  surcharges: [],
  ...over,
});

// A Wednesday midday in Nairobi (UTC+3, no daylight saving): 2026-11-04 12:00 local.
const WEDNESDAY = new Date('2026-11-04T09:00:00Z');
const request = (over: Partial<ChargeRequest> = {}): ChargeRequest => ({ at: WEDNESDAY, timeZone: 'Africa/Nairobi', zoneId: null, out: null, back: null, distanceApproximate: false, orderValue: 1000, weightKg: 1, ...over });
const amount = (p: ChargePolicyDef, r: ChargeRequest): number => {
  const q = quoteCharge(p, r);
  if (!q.ok) throw new Error(`${q.reason}: ${q.message}`);
  return q.amount;
};
const reason = (p: ChargePolicyDef, r: ChargeRequest): string => {
  const q = quoteCharge(p, r);
  return q.ok ? 'OK' : q.reason;
};

describe('the local clock', () => {
  it('reads the day, the minute and the date in the company’s time zone', () => {
    expect(localClock(new Date('2026-11-04T09:00:00Z'), 'Africa/Nairobi')).toEqual({ dayOfWeek: 3, minuteOfDay: 720, monthDay: '11-04' });
    // 22:30 UTC on Saturday is already 01:30 on Sunday in Nairobi.
    expect(localClock(new Date('2026-11-07T22:30:00Z'), 'Africa/Nairobi')).toEqual({ dayOfWeek: 0, minuteOfDay: 90, monthDay: '11-08' });
    expect(localClock(new Date('2026-11-04T00:00:00Z'), 'UTC').minuteOfDay).toBe(0);
    expect(() => localClock(new Date(), 'Mars/Olympus')).toThrow(RangeError);
  });
  it('knows a date range, including one that crosses the new year', () => {
    expect(inDateRange('06-15', '06-01', '08-31')).toBe(true);
    expect(inDateRange('09-01', '06-01', '08-31')).toBe(false);
    expect(inDateRange('12-24', '12-01', '02-28')).toBe(true);
    expect(inDateRange('01-15', '12-01', '02-28')).toBe(true);
    expect(inDateRange('06-01', '12-01', '02-28')).toBe(false);
    expect(inDateRange('12-01', '12-01', '02-28')).toBe(true);
    expect(inDateRange('02-28', '12-01', '02-28')).toBe(true);
  });
  it('lets a window that crosses midnight belong to the day it began', () => {
    const fridayNight = { days: [5], fromMinute: 22 * 60, toMinute: 6 * 60, dateFrom: null, dateTo: null };
    const at = (iso: string) => ruleHolds(fridayNight, localClock(new Date(iso), 'UTC'));
    expect(at('2026-11-06T23:30:00Z')).toBe(true); // Friday 23:30
    expect(at('2026-11-07T02:00:00Z')).toBe(true); // Saturday 02:00 began on Friday
    expect(at('2026-11-07T23:30:00Z')).toBe(false); // Saturday 23:30 began on Saturday
    expect(at('2026-11-06T02:00:00Z')).toBe(false); // Friday 02:00 began on Thursday
    expect(at('2026-11-06T12:00:00Z')).toBe(false); // midday is outside the window
  });
  it('holds a plain window from its start up to, not including, its end', () => {
    const rule = { days: null, fromMinute: 7 * 60, toMinute: 9 * 60, dateFrom: null, dateTo: null };
    const at = (hhmm: string) => ruleHolds(rule, localClock(new Date(`2026-11-04T${hhmm}:00Z`), 'UTC'));
    expect([at('06:59'), at('07:00'), at('08:59'), at('09:00')]).toEqual([false, true, true, false]);
  });
});

describe('a rate card by zone', () => {
  const card = policy({
    method: 'zone_rate',
    rates: [
      { zoneId: 'west', fromKg: 0, toKg: 5, fee: 200, perExtraKg: 0 },
      { zoneId: 'west', fromKg: 5, toKg: null, fee: 300, perExtraKg: 20 },
      { zoneId: null, fromKg: 0, toKg: null, fee: 500, perExtraKg: 0 },
    ],
  });
  it('uses the zone’s own row, and a default row for any other zone', () => {
    expect(amount(card, request({ zoneId: 'west', weightKg: 2 }))).toBe(200);
    expect(amount(card, request({ zoneId: 'east', weightKg: 2 }))).toBe(500);
    expect(amount(card, request({ zoneId: null, weightKg: 2 }))).toBe(500);
  });
  it('includes the start of a weight band and excludes its end', () => {
    expect(amount(card, request({ zoneId: 'west', weightKg: 4.999 }))).toBe(200);
    expect(amount(card, request({ zoneId: 'west', weightKg: 5 }))).toBe(300);
    expect(amount(card, request({ zoneId: 'west', weightKg: 0 }))).toBe(200);
  });
  it('charges each started kilogram above the start of the open top band', () => {
    expect(amount(card, request({ zoneId: 'west', weightKg: 5.2 }))).toBe(320);
    expect(amount(card, request({ zoneId: 'west', weightKg: 8 }))).toBe(360);
    const q = quoteCharge(card, request({ zoneId: 'west', weightKg: 8, zoneName: 'Westlands' }));
    expect(q.ok && q.steps.map((s) => s.label)).toEqual(['Delivery to Westlands over 5 kg', 'KES 20 for each of 3 kg over 5 kg']);
  });
  it('says there is no zone when the card has no default row, and no rate when the weight is not covered', () => {
    const strict = policy({ method: 'zone_rate', rates: [{ zoneId: 'west', fromKg: 0, toKg: 5, fee: 200, perExtraKg: 0 }] });
    expect(reason(strict, request({ zoneId: null }))).toBe('no_zone');
    expect(reason(strict, request({ zoneId: 'east' }))).toBe('no_rate');
    expect(reason(strict, request({ zoneId: 'west', weightKg: 9 }))).toBe('no_rate');
    const q = quoteCharge(strict, request({ zoneId: 'west', weightKg: 9, zoneName: 'Westlands' }));
    expect(!q.ok && q.message).toBe('No delivery fee is set for 9 kg to Westlands.');
  });
});

describe('a flat or by-weight fee', () => {
  const flat = policy({ method: 'flat', rates: [{ zoneId: null, fromKg: 0, toKg: 10, fee: 250, perExtraKg: 0 }, { zoneId: null, fromKg: 10, toKg: null, fee: 400, perExtraKg: 0 }] });
  it('is the same everywhere and needs no zone', () => {
    expect(amount(flat, request({ zoneId: 'anything', weightKg: 3 }))).toBe(250);
    expect(amount(flat, request({ zoneId: null, weightKg: 12 }))).toBe(400);
  });
  it('ignores a zone-specific row, which a flat card should not have', () => {
    const odd = policy({ method: 'flat', rates: [{ zoneId: 'west', fromKg: 0, toKg: null, fee: 1, perExtraKg: 0 }, { zoneId: null, fromKg: 0, toKg: null, fee: 250, perExtraKg: 0 }] });
    expect(amount(odd, request({ zoneId: 'west' }))).toBe(250);
  });
});

describe('a charge by distance', () => {
  const bands = [
    { fromKm: 0, toKm: 5, baseFee: 150, perKm: 0 },
    { fromKm: 5, toKm: 20, baseFee: 150, perKm: 30 },
    { fromKm: 20, toKm: null, baseFee: 750, perKm: 20 },
  ];
  const by = policy({ method: 'distance', bands });
  const leg = (kmValue: number, minutes: number | null = null) => ({ km: kmValue, minutes });
  it('finds the band and charges the base fee plus the rate for the distance past its start', () => {
    expect(amount(by, request({ out: leg(3) }))).toBe(150);
    expect(amount(by, request({ out: leg(5) }))).toBe(150);
    expect(amount(by, request({ out: leg(9.5) }))).toBe(285);
    expect(amount(by, request({ out: leg(20) }))).toBe(750);
    expect(amount(by, request({ out: leg(30) }))).toBe(950);
    const q = quoteCharge(by, request({ out: leg(9.5) }));
    expect(q.ok && q.steps.map((s) => [s.label, s.amount, s.running])).toEqual([['Base fee for 5 km to 20 km', 150, 150], ['KES 30 a km for 4.5 km', 135, 285]]);
  });
  it('needs a distance, and is refused beyond its range, measured one way', () => {
    expect(reason(by, request({ out: null }))).toBe('no_distance');
    const ranged = policy({ method: 'distance', bands, maxRangeKm: 25, distanceBasis: 'round_trip' });
    expect(reason(ranged, request({ out: leg(26) }))).toBe('out_of_range');
    expect(amount(ranged, request({ out: leg(24), back: leg(24) }))).toBe(750 + 20 * 28);
    const q = quoteCharge(ranged, request({ out: leg(26) }));
    expect(!q.ok && q.message).toBe('This address is 26 km away, and this delivery goes up to 25 km.');
  });
  it('uses the longer leg, one way, or there and back, as the policy says', () => {
    const out = leg(8, 20);
    const back = leg(12, 30);
    expect(tripFor('one_way', out, back)).toEqual(out);
    expect(tripFor('longer_leg', out, back)).toEqual(back);
    expect(tripFor('longer_leg', back, out)).toEqual(back);
    expect(tripFor('longer_leg', out, null)).toEqual(out);
    expect(tripFor('round_trip', out, back)).toEqual({ km: 20, minutes: 50 });
    expect(tripFor('round_trip', out, null)).toEqual({ km: 16, minutes: 40 });
    expect(tripFor('round_trip', leg(8, null), back)).toEqual({ km: 20, minutes: null });
    expect(amount(policy({ method: 'distance', bands, distanceBasis: 'longer_leg' }), request({ out, back }))).toBe(150 + 30 * 7);
  });
  it('adds a charge for travel time when the route says how long it takes, and says nothing when it does not', () => {
    const timed = policy({ method: 'distance', bands, perMinute: 2 });
    expect(amount(timed, request({ out: leg(3, 15) }))).toBe(150 + 30);
    expect(amount(timed, request({ out: leg(3, null) }))).toBe(150);
  });
  it('charges weight above the free amount, for each started kilogram', () => {
    const heavy = policy({ method: 'distance', bands, includedKg: 10, perExtraKg: 15 });
    expect(amount(heavy, request({ out: leg(3), weightKg: 10 }))).toBe(150);
    expect(amount(heavy, request({ out: leg(3), weightKg: 10.2 }))).toBe(165);
    expect(amount(heavy, request({ out: leg(3), weightKg: 14 }))).toBe(210);
  });
  it('refuses when no band covers the distance, and records that the distance was only approximate', () => {
    const gappy = policy({ method: 'distance', bands: [{ fromKm: 0, toKm: 5, baseFee: 100, perKm: 0 }] });
    expect(reason(gappy, request({ out: leg(7) }))).toBe('no_rate');
    const q = quoteCharge(by, request({ out: leg(3), distanceApproximate: true }));
    expect(q.ok && q.basis).toMatchObject({ method: 'distance', km: 3, approximate: true, policyId: 'p1', policyVersion: 1 });
    const card = quoteCharge(policy({ rates: [{ zoneId: null, fromKg: 0, toKg: null, fee: 100, perExtraKg: 0 }] }), request({ distanceApproximate: true }));
    expect(card.ok && card.basis.approximate).toBe(false);
  });
});

describe('time rules', () => {
  const base = { method: 'flat' as const, rates: [{ zoneId: null, fromKg: 0, toKg: null, fee: 200, perExtraKg: 0 }] };
  const weekend: Surcharge = { label: 'Weekend', kind: 'fixed', amount: 50, days: [0, 6], fromMinute: null, toMinute: null, dateFrom: null, dateTo: null };
  const night: Surcharge = { label: 'Night delivery', kind: 'percent', amount: 25, days: null, fromMinute: 22 * 60, toMinute: 6 * 60, dateFrom: null, dateTo: null };
  const festive: Surcharge = { label: 'Festive season', kind: 'fixed', amount: 30, days: null, fromMinute: null, toMinute: null, dateFrom: '12-01', dateTo: '01-05' };
  const at = (iso: string) => request({ at: new Date(iso) });
  it('adds a fixed amount on the days named, in the company’s time zone', () => {
    const p = policy({ ...base, surcharges: [weekend] });
    expect(amount(p, at('2026-11-04T09:00:00Z'))).toBe(200); // Wednesday
    expect(amount(p, at('2026-11-07T09:00:00Z'))).toBe(250); // Saturday
    // 22:30 UTC on Friday is 01:30 on Saturday in Nairobi: a weekend there.
    expect(amount(p, at('2026-11-06T22:30:00Z'))).toBe(250);
  });
  it('adds a percentage of the subtotal before any surcharge, so the order they are listed in cannot matter', () => {
    const together = [weekend, night, festive];
    const when = at('2026-12-26T20:00:00Z'); // 23:00 Saturday 26 December in Nairobi: weekend, night and festive
    const a = amount(policy({ ...base, surcharges: together }), when);
    const b = amount(policy({ ...base, surcharges: [...together].reverse() }), when);
    expect(a).toBe(200 + 50 + 50 + 30);
    expect(b).toBe(a);
  });
  it('holds a season that crosses the new year, and not outside it', () => {
    const p = policy({ ...base, surcharges: [festive] });
    expect(amount(p, at('2026-12-31T09:00:00Z'))).toBe(230);
    expect(amount(p, at('2027-01-03T09:00:00Z'))).toBe(230);
    expect(amount(p, at('2027-01-06T09:00:00Z'))).toBe(200);
    expect(amount(p, at('2026-06-15T09:00:00Z'))).toBe(200);
  });
  it('refuses, in words, a time zone that does not exist, but only when a time rule needs it', () => {
    expect(reason(policy({ ...base, surcharges: [weekend] }), { ...at('2026-11-04T09:00:00Z'), timeZone: 'Mars/Olympus' })).toBe('bad_time_zone');
    expect(reason(policy({ ...base }), { ...at('2026-11-04T09:00:00Z'), timeZone: 'Mars/Olympus' })).toBe('OK');
  });
  it('names each surcharge in the explanation', () => {
    const q = quoteCharge(policy({ ...base, surcharges: [night] }), at('2026-11-04T20:30:00Z'));
    expect(q.ok && q.steps.map((s) => [s.kind, s.label, s.amount])).toEqual([['base', 'Delivery', 200], ['surcharge', 'Night delivery (25%)', 50]]);
  });
});

describe('minimum, maximum, order value and rounding', () => {
  const base = { method: 'flat' as const, rates: [{ zoneId: null, fromKg: 0, toKg: null, fee: 180, perExtraKg: 0 }] };
  it('raises a charge to the minimum and holds it to the maximum, and says so', () => {
    expect(amount(policy({ ...base, minCharge: 250 }), request())).toBe(250);
    expect(amount(policy({ ...base, maxCharge: 150 }), request())).toBe(150);
    const q = quoteCharge(policy({ ...base, minCharge: 250 }), request());
    expect(q.ok && q.steps.at(-1)).toMatchObject({ kind: 'minimum', amount: 70, running: 250 });
  });
  it('takes the percentage for the highest order value reached, and free delivery at 100', () => {
    const tiers = [{ minOrderValue: 2000, percentOff: 50 }, { minOrderValue: 5000, percentOff: 100 }, { minOrderValue: 1000, percentOff: 10 }];
    const p = policy({ ...base, tiers });
    expect(amount(p, request({ orderValue: 999 }))).toBe(180);
    expect(amount(p, request({ orderValue: 1000 }))).toBe(162);
    expect(amount(p, request({ orderValue: 2500 }))).toBe(90);
    expect(amount(p, request({ orderValue: 5000 }))).toBe(0);
    const q = quoteCharge(p, request({ orderValue: 6000 }));
    expect(q.ok && q.steps.at(-1)?.label).toBe('Free delivery on orders of KES 5000 or more');
  });
  it('rounds to a unit, nearest or up, and only says so when it changed something', () => {
    expect(amount(policy({ ...base, rates: [{ zoneId: null, fromKg: 0, toKg: null, fee: 183, perExtraKg: 0 }], roundTo: 10 }), request())).toBe(180);
    expect(amount(policy({ ...base, rates: [{ zoneId: null, fromKg: 0, toKg: null, fee: 183, perExtraKg: 0 }], roundTo: 10, roundMode: 'up' }), request())).toBe(190);
    expect(amount(policy({ ...base, rates: [{ zoneId: null, fromKg: 0, toKg: null, fee: 185, perExtraKg: 0 }], roundTo: 10 }), request())).toBe(190);
    const exact = quoteCharge(policy({ ...base, roundTo: 10 }), request());
    expect(exact.ok && exact.steps.map((s) => s.kind)).toEqual(['base']);
  });
  it('refuses an order that is too heavy for the delivery, and input that is not valid', () => {
    expect(reason(policy({ ...base, maxWeightKg: 20 }), request({ weightKg: 21 }))).toBe('too_heavy');
    expect(reason(policy({ ...base, maxWeightKg: 20 }), request({ weightKg: 20 }))).toBe('OK');
    for (const bad of [{ weightKg: -1 }, { weightKg: Number.NaN }, { orderValue: -5 }, { at: new Date('nope') }, { out: { km: -1, minutes: null } }]) expect(reason(policy(base), request(bad)), JSON.stringify(bad)).toBe('bad_input');
  });
});

describe('what every charge promises', () => {
  const everything = policy({
    method: 'distance',
    bands: [{ fromKm: 0, toKm: 10, baseFee: 120, perKm: 17.5 }, { fromKm: 10, toKm: null, baseFee: 295, perKm: 12.25 }],
    perMinute: 1.3,
    includedKg: 5,
    perExtraKg: 7.5,
    minCharge: 150,
    maxCharge: 1500,
    roundTo: 10,
    roundMode: 'up',
    tiers: [{ minOrderValue: 3000, percentOff: 30 }],
    surcharges: [
      { label: 'Weekend', kind: 'fixed', amount: 40, days: [0, 6], fromMinute: null, toMinute: null, dateFrom: null, dateTo: null },
      { label: 'Evening', kind: 'percent', amount: 12.5, days: null, fromMinute: 18 * 60, toMinute: 22 * 60, dateFrom: null, dateTo: null },
    ],
  });
  const pseudo = (start: number) => {
    let seed = start;
    return () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
  };
  it('is the same every time for the same question', () => {
    const r = request({ out: { km: 13.7, minutes: 31 }, weightKg: 8.3, orderValue: 4200 });
    expect(quoteCharge(everything, r)).toEqual(quoteCharge(everything, r));
    expect(quoteCharge(everything, { ...r, at: new Date(r.at.getTime()) })).toEqual(quoteCharge(everything, r));
  });
  it('explains itself: the steps are in order, each running total follows from the one before, and the last is the amount', () => {
    const next = pseudo(7);
    for (let i = 0; i < 400; i += 1) {
      const r = request({ at: new Date(Date.UTC(2026, Math.floor(next() * 12), 1 + Math.floor(next() * 28), Math.floor(next() * 24), Math.floor(next() * 60))), out: { km: next() * 60, minutes: next() > 0.2 ? next() * 120 : null }, back: next() > 0.5 ? { km: next() * 60, minutes: null } : null, weightKg: next() * 30, orderValue: next() * 8000 });
      const q = quoteCharge(everything, r);
      expect(q.ok, JSON.stringify(r)).toBe(true);
      if (!q.ok) continue;
      let before = 0;
      for (const s of q.steps) {
        expect(Math.abs(s.running - (before + s.amount))).toBeLessThan(1e-3);
        before = s.running;
      }
      expect(q.amount).toBe(before);
    }
  });
  it('is never negative, never above the maximum, and always a multiple of the rounding unit', () => {
    const next = pseudo(11);
    for (let i = 0; i < 400; i += 1) {
      const r = request({ at: new Date(Date.UTC(2026, Math.floor(next() * 12), 1 + Math.floor(next() * 28), Math.floor(next() * 24))), out: { km: next() * 400, minutes: next() * 600 }, weightKg: next() * 100, orderValue: next() * 10000 });
      const q = quoteCharge(everything, r);
      if (!q.ok) continue;
      expect(q.amount).toBeGreaterThanOrEqual(0);
      expect(q.amount).toBeLessThanOrEqual(1500);
      expect(Math.abs(q.amount / 10 - Math.round(q.amount / 10))).toBeLessThan(1e-9);
    }
  });
  it('never charges less for a longer trip inside one band, nor more for a bigger order value', () => {
    const plain = policy({ method: 'distance', bands: [{ fromKm: 0, toKm: null, baseFee: 100, perKm: 25 }], roundTo: 1, roundMode: 'up', tiers: [{ minOrderValue: 2000, percentOff: 20 }] });
    let last = 0;
    for (let k = 0; k <= 80; k += 0.5) {
      const a = amount(plain, request({ out: { km: k, minutes: null }, orderValue: 100 }));
      expect(a).toBeGreaterThanOrEqual(last);
      last = a;
      expect(amount(plain, request({ out: { km: k, minutes: null }, orderValue: 5000 }))).toBeLessThanOrEqual(a);
    }
  });
});

describe('days in the business’s time zone', () => {
  it('begins a day at the local midnight, not at midnight UTC', async () => {
    const { startOfLocalDay, nextDay, isDateOnly } = await import('./time');
    expect(startOfLocalDay('2026-11-01', 'Africa/Nairobi').toISOString()).toBe('2026-10-31T21:00:00.000Z');
    expect(startOfLocalDay('2026-11-01', 'UTC').toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(startOfLocalDay('2026-03-08', 'America/New_York').toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(startOfLocalDay('2026-03-09', 'America/New_York').toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(nextDay('2026-12-31')).toBe('2027-01-01');
    expect(nextDay('2028-02-28')).toBe('2028-02-29');
    expect(isDateOnly('2026-02-29')).toBe(false);
    expect(isDateOnly('2028-02-29')).toBe(true);
    expect(isDateOnly('2026-1-1')).toBe(false);
    expect(() => startOfLocalDay('soon', 'UTC')).toThrow(RangeError);
  });
});
