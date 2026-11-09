import { describe, expect, it } from 'vitest';
import { chargeIds, invoiceProblem, reconcile } from './courier-invoice';

const ok = { courierName: ' Swift Couriers ', invoiceNo: ' SW-1001 ', invoiceDate: '2026-11-05', total: 1234.565, note: '  October ' };

describe('a courier invoice as typed', () => {
  it('reads the courier, number, day, total to the cent and note', () => {
    expect(invoiceProblem(ok, '2026-11-09')).toEqual({ value: { courierName: 'Swift Couriers', invoiceNo: 'SW-1001', invoiceDate: '2026-11-05', totalCents: 123457, note: 'October' } });
    expect(invoiceProblem({ ...ok, note: '  ' }, '2026-11-09')).toMatchObject({ value: { note: null } });
    expect(invoiceProblem({ ...ok, invoiceDate: '2026-11-09' }, '2026-11-09')).toHaveProperty('value');
  });

  it('refuses a missing courier or number, a day that is not a day or is in the future, and money that makes no sense', () => {
    for (const bad of [{ courierName: '' }, { courierName: 'x' }, { courierName: 7 }, { invoiceNo: '  ' }, { invoiceDate: '5/11/2026' }, { invoiceDate: '2026-02-31x' }, { invoiceDate: '2026-11-10' }, { total: 0 }, { total: -4 }, { total: Number.NaN }, { total: '100' }, { total: 1e9 }]) {
      expect(invoiceProblem({ ...ok, ...bad }, '2026-11-09')).toHaveProperty('error');
    }
  });

  it('keeps the words short', () => {
    const long = invoiceProblem({ ...ok, courierName: 'c'.repeat(300), invoiceNo: 'n'.repeat(300), note: 'w'.repeat(900) }, '2026-11-09');
    expect('value' in long && [long.value.courierName.length, long.value.invoiceNo.length, long.value.note?.length]).toEqual([120, 60, 300]);
  });
});

describe('where an invoice stands against the charges matched to it', () => {
  it('is open with nothing matched, agreed when equal, and short or over by the difference', () => {
    expect(reconcile(50000, 0)).toEqual({ state: 'open', differenceCents: -50000 });
    expect(reconcile(50000, 50000)).toEqual({ state: 'agreed', differenceCents: 0 });
    expect(reconcile(50000, 42000)).toEqual({ state: 'short', differenceCents: -8000 });
    expect(reconcile(50000, 51050)).toEqual({ state: 'over', differenceCents: 1050 });
  });
});

describe('a chosen list of charges', () => {
  const a = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
  it('keeps whole ids once each', () => {
    expect(chargeIds([a, a.toUpperCase(), '00000000-0000-4000-8000-000000000001'])).toMatchObject({ ok: true });
    expect(chargeIds([a, a])).toEqual({ ok: true, ids: [a] });
  });
  it('refuses none, too many, and what is not an id', () => {
    for (const bad of [undefined, [], 'x', [1], ['nope'], Array.from({ length: 201 }, () => a)]) expect(chargeIds(bad)).toMatchObject({ ok: false });
  });
});
