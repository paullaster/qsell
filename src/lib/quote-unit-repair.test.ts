import { describe, expect, it } from 'vitest';
import { repairLine, type ProductNow, type SavedUnitLine } from './quote-unit-repair';

const saved = (over: Partial<SavedUnitLine> = {}): SavedUnitLine => ({
  unitId: 'u-crate',
  unitCode: 'CRATE',
  enteredQuantity: 3,
  qtyPerUnit: '20',
  quantity: 60,
  unitPrice: 75,
  ...over,
});
const product = (units: [string, string][]): ProductNow => ({
  name: 'Fish',
  baseUnitId: 'u-kg',
  baseUnitCode: 'KG',
  units: new Map(units),
});

describe('a saved quote line and the units its product has now', () => {
  it('needs nothing when the unit is still there at the same size', () => {
    expect(repairLine(saved(), product([['u-crate', '20']]))).toBeNull();
    expect(repairLine(saved(), product([['u-crate', '20.000']]))).toBeNull();
  });

  it('needs nothing for a line in the base unit', () => {
    expect(
      repairLine(
        saved({ unitId: null, unitCode: null, enteredQuantity: null, qtyPerUnit: null }),
        product([]),
      ),
    ).toBeNull();
    expect(repairLine(saved({ unitId: 'u-kg' }), product([]))).toBeNull();
  });

  it('moves a line to the base unit at the same total when the product no longer has its unit', () => {
    const fix = repairLine(saved(), product([]));
    expect(fix?.kind).toBe('switched_to_base');
    expect(fix?.to).toEqual({ quantity: 60, unitPrice: 75, unitId: 'u-kg', unitCode: 'KG' });
    expect(fix?.message).toBe(
      'Fish is no longer sold in CRATE. This line now shows 60 KG at 75 each, which comes to the same total.',
    );
  });

  it('points out a unit whose size changed, and leaves the line alone', () => {
    const fix = repairLine(saved(), product([['u-crate', '24']]));
    expect(fix?.kind).toBe('size_changed');
    expect(fix?.to).toBeUndefined();
    expect(fix?.message).toContain('now holds 24 KG (it held 20 when this line was made)');
  });
});
