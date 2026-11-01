import { describe, expect, it } from 'vitest';
import { quoteCharge } from './engine';
import { LIMITS, validatePolicy } from './validate';
import type { ChargePolicyDef, ChargeRequest, Surcharge } from './types';

const make = (over: Partial<ChargePolicyDef> = {}): ChargePolicyDef => ({
  id: 'p', code: 'STD', name: 'Standard', version: 1, method: 'flat', currency: 'KES', distanceBasis: 'one_way', maxRangeKm: null, perMinute: 0, includedKg: null, perExtraKg: 0, maxWeightKg: null, minCharge: null, maxCharge: null, roundTo: 0, roundMode: 'nearest',
  rates: [{ zoneId: null, fromKg: 0, toKg: null, fee: 200, perExtraKg: 0 }], bands: [], tiers: [], surcharges: [], ...over,
});
const distance = (over: Partial<ChargePolicyDef> = {}): ChargePolicyDef => make({ method: 'distance', rates: [], bands: [{ fromKm: 0, toKm: 10, baseFee: 100, perKm: 10 }, { fromKm: 10, toKm: null, baseFee: 200, perKm: 8 }], ...over });
const zone = (over: Partial<ChargePolicyDef> = {}): ChargePolicyDef => make({ method: 'zone_rate', rates: [{ zoneId: 'z1', fromKg: 0, toKg: 5, fee: 100, perExtraKg: 0 }, { zoneId: 'z1', fromKg: 5, toKg: null, fee: 150, perExtraKg: 10 }], ...over });
const messages = (p: ChargePolicyDef): string[] => validatePolicy(p).map((i) => i.message);
const surcharge = (over: Partial<Surcharge> = {}): Surcharge => ({ label: 'Weekend', kind: 'fixed', amount: 50, days: [0, 6], fromMinute: null, toMinute: null, dateFrom: null, dateTo: null, ...over });

describe('a sound policy', () => {
  it('has no issues, for each method', () => {
    expect(validatePolicy(make())).toEqual([]);
    expect(validatePolicy(zone())).toEqual([]);
    expect(validatePolicy(distance())).toEqual([]);
    expect(validatePolicy(distance({ perMinute: 1.5, includedKg: 10, perExtraKg: 5, maxRangeKm: 80, maxWeightKg: 200, minCharge: 150, maxCharge: 2000, roundTo: 10, roundMode: 'up', tiers: [{ minOrderValue: 2000, percentOff: 50 }, { minOrderValue: 5000, percentOff: 100 }], surcharges: [surcharge(), surcharge({ label: 'Night', kind: 'percent', amount: 20, days: null, fromMinute: 1320, toMinute: 360 }), surcharge({ label: 'Festive', days: null, dateFrom: '12-01', dateTo: '01-05' })] }))).toEqual([]);
  });
});

describe('the basics', () => {
  it('need a code, a name, a currency and a method', () => {
    expect(messages(make({ code: ' ' }))).toContain('Give the policy a code.');
    expect(messages(make({ name: '' }))).toContain('Give the policy a name.');
    expect(messages(make({ currency: 'kes' }))).toContain('The currency is a three-letter code such as KES.');
    expect(messages(make({ method: 'teleport' as never }))).toContain('Choose how the charge is worked out.');
    expect(messages(make({ distanceBasis: 'x' as never }))).toContain('Choose how the distance is measured.');
    expect(messages(make({ roundMode: 'x' as never }))).toContain('Choose how the charge is rounded.');
  });
  it('keep the minimum below the maximum, and both a multiple of the rounding unit so rounding cannot break them', () => {
    expect(messages(make({ minCharge: 500, maxCharge: 400 }))).toContain('The minimum charge is above the maximum charge.');
    expect(messages(make({ roundTo: 10, maxCharge: 255 }))).toContain('The maximum charge must be a multiple of the rounding unit (10), so rounding can never break it.');
    expect(messages(make({ roundTo: 10, minCharge: 105 }))).toContain('The minimum charge must be a multiple of the rounding unit (10), so rounding can never break it.');
    expect(messages(make({ roundTo: 0.5, maxCharge: 255.5 }))).toEqual([]);
    expect(messages(make({ minCharge: -1 }))).toContain('A minimum or maximum charge is zero or more.');
    expect(messages(make({ roundTo: Number.NaN }))).toContain('The rounding unit is zero (no rounding) or more.');
    expect(messages(make({ maxWeightKg: 0 }))).toContain('The heaviest order is more than 0 kg.');
  });
});

describe('a rate card', () => {
  it('needs at least one fee, and the first band of a zone starts at 0 kg', () => {
    expect(messages(make({ rates: [] }))).toContain('Add at least one fee.');
    expect(messages(zone({ rates: [{ zoneId: 'z1', fromKg: 2, toKg: null, fee: 100, perExtraKg: 0 }] }))).toContain('Fees for a zone: the first weight band must start at 0 kg.');
  });
  it('has weight bands that meet exactly, with only the last open', () => {
    const row = (fromKg: number, toKg: number | null) => ({ zoneId: 'z1', fromKg, toKg, fee: 100, perExtraKg: 0 });
    expect(messages(zone({ rates: [row(0, 5), row(6, null)] }))).toContain('Fees for a zone: no fee covers 5 to 6 kg.');
    expect(messages(zone({ rates: [row(0, 5), row(4, null)] }))[0]).toMatch(/overlap/);
    expect(messages(zone({ rates: [row(0, 5), row(5, 9)] }))).toContain('Fees for a zone: the last weight band must have no upper limit, so every weight has a fee.');
    expect(messages(zone({ rates: [row(0, null), row(5, null)] }))).toContain('Fees for a zone: only the last weight band can be open-ended.');
    expect(messages(zone({ rates: [row(0, 0), row(0, null)] })).some((m) => m.includes('must end above'))).toBe(true);
  });
  it('checks each zone’s bands on their own, and the default fees on their own', () => {
    const rows = [{ zoneId: 'z1', fromKg: 0, toKg: null, fee: 100, perExtraKg: 0 }, { zoneId: 'z2', fromKg: 0, toKg: null, fee: 120, perExtraKg: 0 }, { zoneId: null, fromKg: 0, toKg: null, fee: 300, perExtraKg: 0 }];
    expect(messages(zone({ rates: rows }))).toEqual([]);
    expect(messages(zone({ rates: [...rows, { zoneId: 'z2', fromKg: 5, toKg: null, fee: 1, perExtraKg: 0 }] })).length).toBeGreaterThan(0);
  });
  it('allows a fee for each extra kilogram only on the open top band, and a flat card only for any zone', () => {
    expect(messages(zone({ rates: [{ zoneId: 'z1', fromKg: 0, toKg: 5, fee: 100, perExtraKg: 5 }, { zoneId: 'z1', fromKg: 5, toKg: null, fee: 150, perExtraKg: 0 }] }))).toContain('A fee for each extra kilogram belongs to the open top band only.');
    expect(messages(make({ rates: [{ zoneId: 'z1', fromKg: 0, toKg: null, fee: 100, perExtraKg: 0 }] }))).toContain('A flat or by-weight charge is the same in every zone, so its fees are not tied to a zone.');
    expect(messages(make({ rates: [{ zoneId: null, fromKg: 0, toKg: null, fee: -5, perExtraKg: 0 }] }))).toContain('Every fee is a number of zero or more, with weights from 0 kg.');
  });
  it('keeps distance settings out of a card', () => {
    expect(messages(make({ perMinute: 1 }))).toContain('A rate per minute, free weight or furthest distance belong to a charge by distance.');
    expect(messages(make({ bands: [{ fromKm: 0, toKm: null, baseFee: 1, perKm: 1 }] }))).toContain('Distance bands belong to a charge by distance.');
  });
  it('stays within a size that can be read and saved', () => {
    const many = Array.from({ length: LIMITS.rates + 1 }, (_, i) => ({ zoneId: `z${String(i)}`, fromKg: 0, toKg: null, fee: 1, perExtraKg: 0 }));
    expect(messages(zone({ rates: many }))).toContain(`Use at most ${String(LIMITS.rates)} fees.`);
  });
});

describe('distance bands', () => {
  const band = (fromKm: number, toKm: number | null) => ({ fromKm, toKm, baseFee: 100, perKm: 5 });
  it('need at least one band, starting at 0 km, with no gap or overlap, and an open last band', () => {
    expect(messages(distance({ bands: [] }))).toContain('Add at least one distance band.');
    expect(messages(distance({ bands: [band(1, null)] }))).toContain('The first distance band must start at 0 km.');
    expect(messages(distance({ bands: [band(0, 5), band(6, null)] }))).toContain('No band covers 5 to 6 km.');
    expect(messages(distance({ bands: [band(0, 5), band(4, null)] }))[0]).toMatch(/overlap/);
    expect(messages(distance({ bands: [band(0, 5)] }))).toContain('The last distance band must have no upper limit, or set a maximum range instead.');
    expect(messages(distance({ bands: [band(0, null), band(5, null)] }))).toContain('Only the last distance band can be open-ended.');
    expect(messages(distance({ bands: [band(0, 5), band(5, 5), band(5, null)] })).length).toBeGreaterThan(0);
  });
  it('have fees that are numbers of zero or more', () => {
    expect(messages(distance({ bands: [{ fromKm: 0, toKm: null, baseFee: -1, perKm: 5 }] }))).toContain('A distance band needs a base fee and a rate per kilometre of zero or more.');
  });
  it('keep the weight fee, the range and the rate per minute sensible, and do not take a rate card', () => {
    expect(messages(distance({ rates: [{ zoneId: null, fromKg: 0, toKg: null, fee: 1, perExtraKg: 0 }] }))).toContain('A charge by distance does not use a rate card.');
    expect(messages(distance({ maxRangeKm: 0 }))).toContain('The furthest distance is more than 0 km.');
    expect(messages(distance({ perMinute: -1 }))).toContain('The rate per minute is zero or more.');
    expect(messages(distance({ perExtraKg: 5 }))).toContain('Say how much weight is free before the fee for extra kilograms starts.');
  });
});

describe('order-value steps and extra charges', () => {
  it('have percentages that make sense, and a bigger order never gets a smaller discount', () => {
    expect(messages(make({ tiers: [{ minOrderValue: 100, percentOff: 0 }] }))).toContain('The percentage off is above 0 and at most 100 (100 is free delivery).');
    expect(messages(make({ tiers: [{ minOrderValue: 100, percentOff: 101 }] }))).toContain('The percentage off is above 0 and at most 100 (100 is free delivery).');
    expect(messages(make({ tiers: [{ minOrderValue: 100, percentOff: 10 }, { minOrderValue: 100, percentOff: 20 }] }))).toContain('Two steps start at the same order value (100).');
    expect(messages(make({ tiers: [{ minOrderValue: 100, percentOff: 50 }, { minOrderValue: 200, percentOff: 20 }] }))).toContain('A bigger order should not get a smaller discount than a smaller one.');
    expect(messages(make({ tiers: [{ minOrderValue: -1, percentOff: 10 }] }))).toContain('An order value is zero or more.');
  });
  it('have a name, an amount, real days, hours that are both given, and a season that is a real date', () => {
    const msgs = (s: Partial<Surcharge>) => messages(make({ surcharges: [surcharge(s)] }));
    expect(msgs({ label: '' })[0]).toMatch(/give it a name/);
    expect(msgs({ amount: -1 })[0]).toMatch(/amount is zero or more/);
    expect(msgs({ kind: 'percent', amount: 600 })[0]).toMatch(/at most 500%/);
    expect(msgs({ days: [] })[0]).toMatch(/choose days/);
    expect(msgs({ days: [1, 1] })[0]).toMatch(/choose days/);
    expect(msgs({ days: [7] })[0]).toMatch(/choose days/);
    expect(msgs({ fromMinute: 60, toMinute: null })[0]).toMatch(/both the start and the end/);
    expect(msgs({ fromMinute: 60, toMinute: 60 })[0]).toMatch(/different times/);
    expect(msgs({ fromMinute: 1500, toMinute: 60 })[0]).toMatch(/different times/);
    expect(msgs({ dateFrom: '12-01', dateTo: null })[0]).toMatch(/both the first and last date/);
    expect(msgs({ dateFrom: '13-01', dateTo: '01-05' })[0]).toMatch(/month and day/);
    expect(msgs({ dateFrom: '02-30', dateTo: '03-05' })[0]).toMatch(/month and day/);
    expect(msgs({ dateFrom: '02-29', dateTo: '03-05' })).toEqual([]);
    expect(messages(make({ surcharges: Array.from({ length: LIMITS.surcharges + 1 }, () => surcharge()) }))).toContain(`Use at most ${String(LIMITS.surcharges)} extra charges.`);
  });
});

describe('the promise validation makes', () => {
  const pseudo = (start: number) => {
    let seed = start;
    return () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
  };
  it('a policy that passes can always be priced, unless an input it needs is missing', () => {
    const next = pseudo(5);
    const zones = ['z1', 'z2', null];
    let priced = 0;
    for (const policy of [make(), zone({ rates: [{ zoneId: 'z1', fromKg: 0, toKg: 5, fee: 100, perExtraKg: 0 }, { zoneId: 'z1', fromKg: 5, toKg: null, fee: 150, perExtraKg: 10 }, { zoneId: null, fromKg: 0, toKg: null, fee: 300, perExtraKg: 0 }] }), distance({ maxRangeKm: 120, includedKg: 5, perExtraKg: 4, perMinute: 0.5 })]) {
      expect(validatePolicy(policy)).toEqual([]);
      for (let i = 0; i < 300; i += 1) {
        const r: ChargeRequest = { at: new Date(Date.UTC(2026, Math.floor(next() * 12), 1 + Math.floor(next() * 28), Math.floor(next() * 24))), timeZone: 'Africa/Nairobi', zoneId: zones[Math.floor(next() * 3)] ?? null, out: next() > 0.1 ? { km: next() * 150, minutes: next() > 0.3 ? next() * 200 : null } : null, back: null, distanceApproximate: false, orderValue: next() * 9000, weightKg: next() * 80 };
        const q = quoteCharge(policy, r);
        if (q.ok) {
          priced += 1;
          continue;
        }
        // The only reasons left are inputs the request lacks or a limit the policy states.
        expect(['no_zone', 'no_distance', 'out_of_range']).toContain(q.reason);
      }
    }
    expect(priced).toBeGreaterThan(300);
  });
});
