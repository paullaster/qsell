import { describe, expect, it } from 'vitest';
import { creditInBase, creditWords, soldByProduct, type SoldItem } from './credit-units';

const crate = { id: 'u-crate', code: 'CRATE', qtyPerUnit: '20' };
const fish = (over: Partial<SoldItem> = {}): SoldItem => ({
  productId: 'fish',
  description: 'Fish',
  quantity: 60,
  unitPrice: 300,
  amount: 18000,
  unit: crate,
  baseDecimals: 3,
  baseUnitId: 'u-kg',
  baseUnitName: 'Kilogram',
  ...over,
});

describe('the invoice per product', () => {
  it('keeps one line as it is', () => {
    expect(soldByProduct([fish()])).toEqual([{ ...fish(), lines: 1 }]);
  });

  it('adds the lines of one product up and keeps the unit only when they share it', () => {
    const [same] = soldByProduct([
      fish({ quantity: 20, amount: 6000 }),
      fish({ quantity: 40, amount: 12000 }),
    ]);
    expect(same).toMatchObject({
      quantity: 60,
      amount: 18000,
      unitPrice: 300,
      unit: crate,
      lines: 2,
    });
    const [mixed] = soldByProduct([
      fish({ quantity: 10, amount: 3000, unit: null }),
      fish({ quantity: 20, amount: 6000 }),
    ]);
    expect(mixed).toMatchObject({ quantity: 30, amount: 9000, unit: null });
  });

  it('averages the price when the lines were sold at different prices', () => {
    const [p] = soldByProduct([
      fish({ quantity: 10, unitPrice: 300, amount: 3000, unit: null }),
      fish({ quantity: 10, unitPrice: 200, amount: 2000, unit: null }),
    ]);
    expect(p).toMatchObject({ quantity: 20, amount: 5000, unitPrice: 250 });
  });

  it('keeps products apart and adds up without floating point noise', () => {
    const rows = soldByProduct([
      fish({ quantity: 0.1, amount: 30, unit: null }),
      fish({ quantity: 0.2, amount: 60, unit: null }),
      fish({ productId: 'other' }),
    ]);
    expect(rows.map((r) => [r.productId, r.quantity])).toEqual([
      ['fish', 0.3],
      ['other', 60],
    ]);
  });
});

describe('a credit in base units', () => {
  const [sold] = soldByProduct([fish()]);
  if (sold === undefined) throw new Error('no line');

  it('turns crates into kilograms with the conversion kept on the line', () => {
    expect(creditInBase(sold, { productId: 'fish', quantity: 1.5, unitId: 'u-crate' })).toEqual({
      ok: true,
      value: { base: 30, unit: crate, entered: 1.5 },
    });
  });

  it('takes a plain quantity, or the base unit, as base units', () => {
    expect(creditInBase(sold, { productId: 'fish', quantity: 2.5 })).toEqual({
      ok: true,
      value: { base: 2.5, unit: null, entered: null },
    });
    expect(creditInBase(sold, { productId: 'fish', quantity: 2.5, unitId: 'u-kg' })).toMatchObject({
      ok: true,
      value: { base: 2.5 },
    });
  });

  it('refuses a unit the goods were not sold in, naming the right ones', () => {
    const res = creditInBase(sold, { productId: 'fish', quantity: 1, unitId: 'u-sack' });
    expect(res).toMatchObject({ ok: false });
    expect(res.ok ? '' : res.error).toContain('was sold in CRATE');
    const plain = soldByProduct([fish({ unit: null })])[0];
    if (plain === undefined) throw new Error('no line');
    expect(creditInBase(plain, { productId: 'fish', quantity: 1, unitId: 'u-sack' })).toMatchObject(
      { ok: false },
    );
  });

  it('refuses more decimals than the base unit holds, in either unit', () => {
    expect(creditInBase(sold, { productId: 'fish', quantity: 0.0004 })).toMatchObject({
      ok: false,
    });
    expect(
      creditInBase(sold, { productId: 'fish', quantity: 1.0004, unitId: 'u-crate' }),
    ).toMatchObject({ ok: false });
    const pieces = soldByProduct([fish({ unit: null, baseDecimals: 0, baseUnitName: 'Piece' })])[0];
    if (pieces === undefined) throw new Error('no line');
    expect(creditInBase(pieces, { productId: 'fish', quantity: 1.5 })).toMatchObject({ ok: false });
  });
});

describe('credit in words', () => {
  it('writes base units in the unit sold', () => {
    expect(creditWords(30, crate)).toBe('1.5 CRATE');
    expect(creditWords(10, null)).toBe('10');
  });
});
