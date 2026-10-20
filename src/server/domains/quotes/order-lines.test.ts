import { describe, expect, it } from 'vitest';
import { mergeLinesForOrder } from './order-lines';

const line = (productId: string, quantity: number, amount: number, isGift = false) => ({
  productId,
  quantity: quantity.toFixed(3),
  lineAmount: amount.toFixed(2),
  isGift,
});

describe('turning quote lines into order lines', () => {
  it('leaves distinct products alone', () => {
    const out = mergeLinesForOrder([line('a', 1, 100), line('b', 2, 50, true)]);
    expect(out.map((l) => [l.productId, l.quantity, l.lineAmount, l.isGift])).toEqual([
      ['a', '1.000', '100.00', false],
      ['b', '2.000', '50.00', true],
    ]);
  });

  it('folds a gift of a bought product into the bought line: more units, the same amount', () => {
    const out = mergeLinesForOrder([line('pen', 2, 100), line('pen', 1, 0, true)]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ quantity: '3.000', lineAmount: '100.00', isGift: false });
  });

  it('two gifts of the same product stay a gift', () => {
    const out = mergeLinesForOrder([line('pen', 1, 0, true), line('pen', 1, 0, true)]);
    expect(out[0]).toMatchObject({ quantity: '2.000', isGift: true });
  });

  it('does not change the lines it is given', () => {
    const input = [line('pen', 2, 100), line('pen', 1, 0, true)];
    mergeLinesForOrder(input);
    expect(input[0]!.quantity).toBe('2.000');
  });

  it('keeps lines with no product apart', () => {
    expect(
      mergeLinesForOrder([
        { ...line('x', 1, 1), productId: null },
        { ...line('x', 1, 1), productId: null },
      ]),
    ).toHaveLength(2);
  });

  describe('lines typed in a unit', () => {
    const typed = (productId: string, base: number, entered: number, unitId: string | null, amount: number) => ({
      ...line(productId, base, amount),
      unitId,
      unitCode: unitId === null ? null : 'CRATE',
      enteredQuantity: unitId === null ? null : entered,
      qtyPerUnit: unitId === null ? null : '20',
      enteredUnitPrice: unitId === null ? null : '1500.0000',
    });

    it('keeps the unit when two lines of a product are in the same unit, adding what was typed', () => {
      const out = mergeLinesForOrder([typed('fish', 60, 3, 'u1', 4500), typed('fish', 20, 1, 'u1', 1500)]);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ quantity: '80.000', lineAmount: '6000.00', unitId: 'u1', enteredQuantity: 4, enteredUnitPrice: null });
    });

    it('goes back to the base unit when the lines were typed in different units', () => {
      const out = mergeLinesForOrder([typed('fish', 60, 3, 'u1', 4500), typed('fish', 5, 0, null, 500)]);
      expect(out[0]).toMatchObject({ quantity: '65.000', unitId: null, unitCode: null, enteredQuantity: null, qtyPerUnit: null, enteredUnitPrice: null });
    });
  });
});
