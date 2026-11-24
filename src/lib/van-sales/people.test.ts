import { describe, expect, it } from 'vitest';
import { locationCodeFor, modesWords, readRep, readReason, readVan } from './people';

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const van = { name: 'KDA 123X', branchId: id(1), vehicleId: id(2), cashAccountId: id(3), maxCash: 50000 };

describe('reading a van', () => {
  it('takes a name, branch, vehicle, cash account and a cash limit', () => {
    expect(readVan(van)).toEqual({ ok: true, van });
    expect(readVan({ ...van, name: '  Kiambu   van  ', vehicleId: '', cashAccountId: null, maxCash: '' })).toEqual({ ok: true, van: { ...van, name: 'Kiambu van', vehicleId: null, cashAccountId: null, maxCash: null } });
    expect(readVan({ ...van, maxCash: '12000.456' })).toMatchObject({ ok: true, van: { maxCash: 12000.46 } });
  });
  it.each([
    [null, 'could not be read'],
    [{ ...van, name: 'A' }, 'name of 2 to 60'],
    [{ ...van, name: 'x'.repeat(61) }, 'name of 2 to 60'],
    [{ ...van, branchId: 'nope' }, 'Choose the branch'],
    [{ ...van, vehicleId: 'nope' }, 'vehicle from the list'],
    [{ ...van, cashAccountId: 12 }, 'cash account from the list'],
    [{ ...van, maxCash: 0 }, 'more than nothing'],
    [{ ...van, maxCash: -5 }, 'more than nothing'],
    [{ ...van, maxCash: 'lots' }, 'more than nothing'],
  ])('refuses %j in words', (raw, words) => {
    const r = readVan(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(words);
  });
});

describe('the location code of a van', () => {
  it('is made from its name and kept different from the codes in use', () => {
    expect(locationCodeFor('KDA 123X', new Set())).toBe('VAN-KDA-123X');
    expect(locationCodeFor('KDA 123X', new Set(['van-kda-123x']))).toBe('VAN-KDA-123X-2');
    expect(locationCodeFor('KDA 123X', new Set(['van-kda-123x', 'van-kda-123x-2']))).toBe('VAN-KDA-123X-3');
    expect(locationCodeFor('Kiambu / Ruiru (north)', new Set())).toBe('VAN-KIAMBU-RUIRU-NORTH');
    expect(locationCodeFor('***', new Set())).toBe('VAN-1');
    expect(locationCodeFor('x'.repeat(60), new Set()).length).toBeLessThanOrEqual(24);
  });
});

describe('a reason', () => {
  it('is needed, in the person\'s words', () => {
    expect(readReason('  Van sold   in March ')).toEqual({ ok: true, reason: 'Van sold in March' });
    expect(readReason('no').ok).toBe(false);
    expect(readReason(undefined).ok).toBe(false);
    expect(readReason('x'.repeat(301)).ok).toBe(false);
  });
});

const limits = { maxDiscountPercent: 5, maxCreditPerDay: 20000, mayOverridePrice: false, maySellOnCredit: true };
const rep = { userId: id(9), phone: '+254 700 000 000', homeBranchId: id(1), modes: ['van_sell', 'pre_sell'], limits };

describe('reading a sales rep', () => {
  it('takes who, how to reach them, what they do and what they may do alone', () => {
    expect(readRep(rep, true)).toEqual({ ok: true, rep: { ...rep, modes: ['van_sell', 'pre_sell'] } });
    expect(readRep({ ...rep, modes: ['pre_sell'], phone: '', homeBranchId: '' }, true)).toMatchObject({ ok: true, rep: { modes: ['pre_sell'], phone: null, homeBranchId: null } });
  });
  it('needs the person only when adding, and never changes them after', () => {
    expect(readRep({ ...rep, userId: undefined }, false)).toMatchObject({ ok: true, rep: { userId: null } });
    expect(readRep({ ...rep, userId: undefined }, true).ok).toBe(false);
    expect(readRep({ ...rep, userId: id(7) }, false)).toMatchObject({ ok: true, rep: { userId: null } });
  });
  it.each([
    [{ ...rep, phone: 'call me' }, 'phone number'],
    [{ ...rep, homeBranchId: 'x' }, 'branch from the list'],
    [{ ...rep, modes: [] }, 'what the rep does'],
    [{ ...rep, modes: ['driving'] }, 'what the rep does'],
    [{ ...rep, modes: ['van_sell', 'van_sell'] }, 'what the rep does'],
    [{ ...rep, modes: ['van_sell', 'driving'] }, 'what the rep does'],
    [{ ...rep, limits: { ...limits, maxDiscountPercent: 150 } }, 'percent from 0 to 100'],
    [null, 'could not be read'],
  ])('refuses %j in words', (raw, words) => {
    const r = readRep(raw, true);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(words);
  });
  it('says what a rep does', () => {
    expect(modesWords(['van_sell'])).toBe('Van sell');
    expect(modesWords(['van_sell', 'pre_sell'])).toBe('Van sell and Pre-sell');
  });
});
