import { describe, expect, it } from 'vitest';
import { clockMinutes, clockText } from './clock-time';
import { emptyPolicyForm, emptyRate, emptySurcharge, formFromPolicy, nextKey, payloadFromForm } from './charge-policy-form';
import { readPolicyInput } from '@/server/domains/delivery/domain/read';
import { validatePolicy } from '@/server/domains/delivery/domain/validate';
import type { ChargePolicyDef } from '@/server/domains/delivery/domain/types';

const ZONE = '3f0c7c9e-5a1b-4c1e-9d3a-2b7f8e6a1c40';

describe('clock times', () => {
  it('go both ways, with 24:00 for the end of the day', () => {
    expect(clockText(0)).toBe('00:00');
    expect(clockText(1320)).toBe('22:00');
    expect(clockText(1440)).toBe('24:00');
    expect(clockText(65)).toBe('01:05');
    expect(clockMinutes('22:00')).toBe(1320);
    expect(clockMinutes('6:30')).toBe(390);
    expect(clockMinutes('24:00')).toBe(1440);
    for (const bad of ['', 'soon', '25:00', '12:60', '12', '24:01']) expect(clockMinutes(bad), bad).toBeNaN();
    for (const m of [0, 1, 59, 60, 361, 1439, 1440]) expect(clockMinutes(clockText(m))).toBe(m);
  });
});

describe('the policy form', () => {
  const def: ChargePolicyDef = {
    id: 'p', code: 'STD', name: 'Standard', version: 2, method: 'zone_rate', currency: 'KES', distanceBasis: 'one_way', maxRangeKm: null, perMinute: 0, includedKg: null, perExtraKg: 0, maxWeightKg: 50, minCharge: 150, maxCharge: 2000, roundTo: 10, roundMode: 'up',
    rates: [{ zoneId: ZONE, fromKg: 0, toKg: 5, fee: 200, perExtraKg: 0 }, { zoneId: ZONE, fromKg: 5, toKg: null, fee: 300, perExtraKg: 20 }, { zoneId: null, fromKg: 0, toKg: null, fee: 500, perExtraKg: 0 }],
    bands: [], tiers: [{ minOrderValue: 3000, percentOff: 100 }],
    surcharges: [{ label: 'Weekend', kind: 'fixed', amount: 50, days: [0, 6], fromMinute: null, toMinute: null, dateFrom: null, dateTo: null }, { label: 'Night', kind: 'percent', amount: 20, days: null, fromMinute: 1320, toMinute: 360, dateFrom: '12-01', dateTo: '01-05' }],
  };
  const policy = { code: 'STD', description: null, priority: 7, firstDay: '2026-11-01', lastDay: null, scopes: { branch: { op: 'in' as const, values: ['b1'] }, channel: { op: 'not_in' as const, values: ['pos_cash_sale'] } }, def };

  it('starts empty and sound enough to fill in', () => {
    const f = emptyPolicyForm();
    expect(f).toMatchObject({ method: 'flat', currency: 'KES', priority: '0', rates: [{ fromKg: '0' }], bands: [{ fromKm: '0' }] });
    expect(emptyPolicyForm('USD').currency).toBe('USD');
    expect(emptySurcharge().days).toHaveLength(7);
  });
  it('shows a policy with the words for its zones and who it is for', () => {
    const f = formFromPolicy(policy, { zones: { [ZONE]: 'Westlands' }, scopes: { branch: { b1: 'NBO — Nairobi' }, channel: { pos_cash_sale: 'Point of sale' } } });
    expect(f.scopes).toEqual({ branch: { op: 'in', chosen: [{ id: 'b1', label: 'NBO — Nairobi' }] }, channel: { op: 'not_in', chosen: [{ id: 'pos_cash_sale', label: 'Point of sale' }] } });
    expect(f.rates[0]).toMatchObject({ zone: { id: ZONE, label: 'Westlands' }, fromKg: '0', toKg: '5', fee: '200' });
    expect(f.rates[2]?.zone).toBeNull();
    expect(f.surcharges[0]).toMatchObject({ days: [true, false, false, false, false, false, true], hoursOn: false, seasonOn: false });
    expect(f.surcharges[1]).toMatchObject({ hoursOn: true, from: '22:00', to: '06:00', seasonOn: true, dateFrom: '12-01', dateTo: '01-05' });
    expect(f).toMatchObject({ priority: '7', minCharge: '150', maxCharge: '2000', roundTo: '10', roundMode: 'up', maxWeightKg: '50', lastDay: '', firstDay: '2026-11-01' });
  });
  it('falls back to the id when a name is not known', () => {
    const f = formFromPolicy(policy, { zones: {}, scopes: {} });
    expect(f.rates[0]?.zone?.label).toBe(ZONE);
    expect(f.scopes.branch?.chosen[0]?.label).toBe('b1');
  });
  it('goes to the server and back without changing the policy', () => {
    const form = formFromPolicy(policy, { zones: { [ZONE]: 'Westlands' }, scopes: {} });
    const read = readPolicyInput(payloadFromForm(form));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.rates).toEqual(def.rates);
    expect(read.value.tiers).toEqual(def.tiers);
    expect(read.value.surcharges).toEqual(def.surcharges);
    expect(read.value).toMatchObject({ name: 'Standard', method: 'zone_rate', minCharge: 150, maxCharge: 2000, roundTo: 10, roundMode: 'up', maxWeightKg: 50, scopes: policy.scopes });
    expect(validatePolicy({ ...read.value, id: 'x', code: 'STD', version: 1 })).toEqual([]);
  });
  it('sends only what the chosen method uses', () => {
    const distance = { ...emptyPolicyForm(), method: 'distance' as const, name: 'By km', bands: [{ key: '0', fromKm: '0', toKm: '', baseFee: '100', perKm: '10' }], rates: [{ key: '0', zone: { id: ZONE, label: 'Z' }, fromKg: '0', toKg: '', fee: '1', perExtraKg: '' }], maxRangeKm: '50', perMinute: '2' };
    const sent = payloadFromForm(distance);
    expect(sent.rates).toEqual([]);
    expect(sent).toMatchObject({ maxRangeKm: '50', perMinute: '2' });
    const flat = { ...emptyPolicyForm(), name: 'Flat', maxRangeKm: '50', perMinute: '2', includedKg: '5', rates: [{ key: '0', zone: { id: ZONE, label: 'Z' }, fromKg: '0', toKg: '', fee: '250', perExtraKg: '' }] };
    const sentFlat = payloadFromForm(flat);
    expect(sentFlat).toMatchObject({ maxRangeKm: '', perMinute: '', includedKg: '', bands: [] });
    expect((sentFlat.rates as { zoneId: string }[])[0]?.zoneId).toBe('');
    const read = readPolicyInput(sentFlat);
    expect(read.ok && validatePolicy({ ...read.value, id: 'x', code: 'F', version: 1 })).toEqual([]);
  });
  it('sends hours and a season only when they are switched on, and a time that is not a time is caught by the server', () => {
    const f = { ...emptyPolicyForm(), name: 'x', rates: [{ key: '0', zone: null, fromKg: '0', toKg: '', fee: '100', perExtraKg: '' }], surcharges: [{ ...emptySurcharge(), label: 'Late', amount: '30', hoursOn: true, from: 'late', to: '06:00' }] };
    const sent = payloadFromForm(f).surcharges as { fromMinute: unknown; days: unknown; dateFrom: unknown }[];
    expect(sent[0]?.fromMinute).toBe('late');
    expect(sent[0]?.days).toBeNull();
    expect(sent[0]?.dateFrom).toBeNull();
    expect(readPolicyInput(payloadFromForm(f))).toMatchObject({ ok: false, error: 'Extra charge 1: the start of the hours must be a time such as 22:00.' });
    const off = payloadFromForm({ ...f, surcharges: [{ ...emptySurcharge(), label: 'Day', amount: '5' }] }).surcharges as { fromMinute: unknown }[];
    expect(off[0]?.fromMinute).toBeNull();
  });
});

describe('keys for the rows of a list', () => {
  it('are never repeated, even after a row in the middle is removed', () => {
    expect(nextKey([])).toBe('0');
    const rows = [emptyRate('0'), emptyRate('1'), emptyRate('2')];
    expect(nextKey(rows)).toBe('3');
    expect(nextKey(rows.filter((r) => r.key !== '1'))).toBe('3');
    expect(nextKey(rows.filter((r) => r.key !== '2'))).toBe('2');
    expect(formFromPolicy({ code: 'S', description: null, priority: 0, firstDay: '2026-01-01', lastDay: null, scopes: {}, def: { id: 'p', code: 'S', name: 'S', version: 1, method: 'flat', currency: 'KES', distanceBasis: 'one_way', maxRangeKm: null, perMinute: 0, includedKg: null, perExtraKg: 0, maxWeightKg: null, minCharge: null, maxCharge: null, roundTo: 0, roundMode: 'nearest', rates: [{ zoneId: null, fromKg: 0, toKg: 5, fee: 1, perExtraKg: 0 }, { zoneId: null, fromKg: 5, toKg: null, fee: 2, perExtraKg: 0 }], bands: [], tiers: [], surcharges: [] } }, { zones: {}, scopes: {} }).rates.map((r) => r.key)).toEqual(['0', '1']);
  });
});
