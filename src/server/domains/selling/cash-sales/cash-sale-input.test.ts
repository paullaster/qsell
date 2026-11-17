import { describe, expect, it } from 'vitest';
import { parseCashSale, parseCashSaleLines } from './cash-sale-input';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const base = { lines: [{ productId: 'prod_1', quantity: 2 }], tenders: [{ methodId: id(1), amount: 500, reference: '' }], saleKey: id(9) };

describe('reading a counter sale', () => {
  it('reads the lines, the customer if one was chosen, the tenders and the key', () => {
    const r = parseCashSale({ ...base, customerId: id(5) });
    expect(r).toEqual({ ok: true, sale: { customerId: id(5), lines: [{ productId: 'prod_1', quantity: 2 }], tenders: [{ methodId: id(1), amount: 500, reference: '' }], saleKey: id(9) } });
    expect(parseCashSale(base)).toMatchObject({ ok: true, sale: { customerId: null } });
    expect(parseCashSale({ ...base, customerId: '' })).toMatchObject({ ok: true, sale: { customerId: null } });
  });
  it('refuses what is not a sale: no lines, no tenders, a bad key, a bad customer, a bad amount', () => {
    expect(parseCashSale({ ...base, lines: [] }).ok).toBe(false);
    expect(parseCashSale({ ...base, tenders: [] }).ok).toBe(false);
    expect(parseCashSale({ ...base, saleKey: 'abc' })).toEqual({ ok: false, error: 'This sale could not be told apart from another. Start the sale again.' });
    expect(parseCashSale({ ...base, customerId: 'nope' }).ok).toBe(false);
    for (const amount of [0, -1, Number.NaN, '5', 1e12]) expect(parseCashSale({ ...base, tenders: [{ methodId: id(1), amount, reference: '' }] }).ok).toBe(false);
    expect(parseCashSale({ ...base, tenders: [{ methodId: 'x', amount: 5, reference: '' }] }).ok).toBe(false);
    expect(parseCashSale(null).ok).toBe(false);
    expect(parseCashSale({ ...base, tenders: Array.from({ length: 5 }, (_, n) => ({ methodId: id(n + 1), amount: 1, reference: '' })) }).ok).toBe(false);
  });
  it('trims and bounds the reference, and reads lines alone for pricing', () => {
    const r = parseCashSale({ ...base, tenders: [{ methodId: id(1), amount: 5, reference: `  ${'x'.repeat(100)}  ` }] });
    expect(r.ok ? r.sale.tenders[0]?.reference.length : 0).toBe(60);
    expect(parseCashSaleLines({ lines: base.lines })).toMatchObject({ ok: true, customerId: null });
  });
});
