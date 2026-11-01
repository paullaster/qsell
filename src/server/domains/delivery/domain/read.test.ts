import { describe, expect, it } from 'vitest';
import { readPolicyInput } from './read';
import { LIMITS, validatePolicy } from './validate';

const ZONE = '3f0c7c9e-5a1b-4c1e-9d3a-2b7f8e6a1c40';
const base = { name: ' Standard ', method: 'flat', currency: 'kes', rates: [{ zoneId: '', fromKg: '0', toKg: '', fee: '250' }] };
const err = (raw: unknown): string => {
  const r = readPolicyInput(raw);
  return r.ok ? 'OK' : r.error;
};

describe('reading a policy from the browser', () => {
  it('trims, upper-cases the currency, reads numbers written as text, and fills what is left out', () => {
    const r = readPolicyInput({ ...base, priority: '3', minCharge: '100', maxCharge: '', validFrom: '2026-11-01', description: '  x  ' });
    expect(r).toMatchObject({ ok: true, value: { name: 'Standard', currency: 'KES', method: 'flat', priority: 3, minCharge: 100, maxCharge: null, perMinute: 0, roundTo: 0, roundMode: 'nearest', distanceBasis: 'one_way', description: 'x', scopes: {}, bands: [], tiers: [], surcharges: [] } });
    expect(r.ok && r.value.validFrom?.toISOString().slice(0, 10)).toBe('2026-11-01');
    expect(r.ok && r.value.rates).toEqual([{ zoneId: null, fromKg: 0, toKg: null, fee: 250, perExtraKg: 0 }]);
  });
  it('reads a rate card for zones, bands, steps and time rules', () => {
    const r = readPolicyInput({
      name: 'Zones', method: 'zone_rate', currency: 'KES',
      rates: [{ zoneId: ZONE, fromKg: 0, toKg: 5, fee: 100, perExtraKg: 0 }],
      tiers: [{ minOrderValue: '2000', percentOff: '50' }],
      surcharges: [{ label: ' Weekend ', kind: 'fixed', amount: '50', days: [0, 6], fromMinute: '', toMinute: '', dateFrom: '', dateTo: '' }, { label: 'Night', kind: 'percent', amount: 20, days: null, fromMinute: 1320, toMinute: 360, dateFrom: '12-01', dateTo: '01-05' }],
    });
    expect(r.ok && r.value.rates[0]?.zoneId).toBe(ZONE);
    expect(r.ok && r.value.tiers).toEqual([{ minOrderValue: 2000, percentOff: 50 }]);
    expect(r.ok && r.value.surcharges.map((s) => [s.label, s.days, s.fromMinute, s.dateFrom])).toEqual([['Weekend', [0, 6], null, null], ['Night', null, 1320, '12-01']]);
  });
  it('refuses, in words, what is not a policy', () => {
    expect(err(null)).toBe('The policy is not valid.');
    expect(err([])).toBe('The policy is not valid.');
    expect(err({ ...base, name: '' })).toBe('Give the policy a name.');
    expect(err({ ...base, name: 'x'.repeat(81) })).toBe('A policy name is at most 80 characters.');
    expect(err({ ...base, method: 'teleport' })).toBe('Choose how the charge is worked out.');
    expect(err({ ...base, distanceBasis: 'sideways' })).toBe('Choose how the distance is measured.');
    expect(err({ ...base, roundMode: 'down' })).toBe('Choose how the charge is rounded.');
    expect(err({ ...base, priority: 'high' })).toBe('The priority must be a number.');
    expect(err({ ...base, minCharge: 'lots' })).toBe('The minimum charge must be a number.');
    expect(err({ ...base, validFrom: 'someday' })).toBe('The start date is not a date.');
    expect(err({ ...base, rates: 'many' })).toBe('fees must be a list.');
    expect(err({ ...base, rates: [{ fee: 'cheap' }] })).toBe('Fee 1: the fee must be a number.');
    expect(err({ ...base, rates: [{ fee: 1, zoneId: 'not-a-uuid' }] })).toBe('Fee 1: that zone is not valid.');
    expect(err({ ...base, rates: ['x'] })).toBe('Fee 1 is not valid.');
    expect(err({ ...base, tiers: [{ minOrderValue: 1 }] })).toBe('Step 1: the percentage off must be a number.');
    expect(err({ ...base, surcharges: [{ label: 'x', kind: 'weird', amount: 1 }] })).toBe('Extra charge 1: choose a fixed amount or a percentage.');
    expect(err({ ...base, scopes: { planet: { op: 'in', values: ['mars'] } } })).toMatch(/not something a price list can be limited by/);
    expect(err({ ...base, scopes: 'everyone' })).toBe('Who the policy is for is not valid.');
  });
  it('refuses lists that are far too long before doing any work on them', () => {
    expect(err({ ...base, rates: new Array<unknown>(LIMITS.rates + 1).fill({ fee: 1 }) })).toBe(`Use at most ${String(LIMITS.rates)} fees.`);
    expect(err({ ...base, bands: new Array<unknown>(LIMITS.bands + 1).fill({ baseFee: 1 }) })).toBe(`Use at most ${String(LIMITS.bands)} distance bands.`);
    expect(err({ ...base, surcharges: new Array<unknown>(LIMITS.surcharges + 1).fill({}) })).toBe(`Use at most ${String(LIMITS.surcharges)} extra charges.`);
  });
  it('never throws, whatever it is given, and a policy it reads can be checked for soundness', () => {
    for (const junk of [undefined, 0, 'x', true, [], {}, { name: {} }, { ...base, rates: [null] }, { ...base, scopes: { branch: null } }, { ...base, surcharges: [{ days: 'all' }] }]) expect(() => readPolicyInput(junk)).not.toThrow();
    const r = readPolicyInput(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(validatePolicy({ ...r.value, id: 'x', code: 'STD', version: 1 })).toEqual([]);
  });
});
