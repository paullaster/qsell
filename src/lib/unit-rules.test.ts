import { describe, expect, it } from 'vitest';
import {
  changesMeaning,
  checkPackagings,
  checkUnit,
  cleanFactor,
  convertQuantity,
  draftFromUnit,
  emptyUnitDraft,
  lineDisplay,
  lineFromRow,
  lineInBase,
  quantityProblem,
  quantityStep,
  quantityWords,
  toBaseQuantity,
  usageWords,
  type UnitDraft,
  type UnitFields,
} from './unit-rules';

const draft = (over: Partial<UnitDraft> = {}): UnitDraft => ({
  ...emptyUnitDraft(),
  code: 'kg',
  name: 'Kilogram',
  decimals: '3',
  ...over,
});

describe('checkUnit', () => {
  it('cleans a base unit', () => {
    const r = checkUnit(
      draft({ code: ' kg ', symbol: ' kg ', internationalCode: 'kgm', etimsCode: 'kg' }),
    );
    expect(r).toEqual({
      ok: true,
      value: {
        code: 'KG',
        name: 'Kilogram',
        description: null,
        symbol: 'kg',
        kind: 'count',
        baseUnitId: null,
        factorToBase: '1',
        decimals: 3,
        internationalCode: 'KGM',
        etimsCode: 'KG',
      },
    });
  });

  it('keeps the factor of a multiple, as a clean decimal', () => {
    const r = checkUnit(
      draft({
        code: 'G',
        name: 'Gram',
        kind: 'mass',
        baseUnitId: 'u1',
        factorToBase: '0.0010',
        decimals: '0',
      }),
    );
    expect(r.ok && r.value.factorToBase).toBe('0.001');
  });

  it('forces a base unit to a factor of 1', () => {
    const r = checkUnit(draft({ factorToBase: '5' }));
    expect(r.ok && r.value.factorToBase).toBe('1');
  });

  it.each([
    [{ code: '' }, /code/i],
    [{ code: '-KG' }, /code/i],
    [{ code: 'A'.repeat(21) }, /code/i],
    [{ name: '   ' }, /name/i],
    [{ name: 'x'.repeat(81) }, /name/i],
    [{ kind: 'weight' }, /kind/i],
    [{ decimals: '7' }, /decimals/i],
    [{ decimals: '1.5' }, /decimals/i],
    [{ decimals: '' }, /decimals/i],
    [{ internationalCode: 'KGMS' }, /international/i],
    [{ etimsCode: 'TOOLONG' }, /eTIMS/],
    [{ symbol: 'x'.repeat(13) }, /symbol/i],
    [{ baseUnitId: 'u1', factorToBase: '0' }, /more than zero/],
    [{ baseUnitId: 'u1', factorToBase: '-2' }, /positive/],
    [{ baseUnitId: 'u1', factorToBase: 'abc' }, /positive/],
    [{ kind: 'packaging', baseUnitId: 'u1', factorToBase: '2' }, /packaging/i],
  ] as [Partial<UnitDraft>, RegExp][])('refuses %j', (over, words) => {
    const r = checkUnit(draft(over));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(words);
  });
});

describe('convertQuantity', () => {
  it('converts within a family exactly and rounds to the target decimals', () => {
    expect(convertQuantity('1500', '0.001', '1', 3)).toBe('1.500');
    expect(convertQuantity('2', '1', '0.001', 0)).toBe('2000');
    expect(convertQuantity('1', '0.45359237', '1', 3)).toBe('0.454');
    expect(convertQuantity('0.1', '1', '1', 1)).toBe('0.1');
  });

  it('has no floating point drift', () => {
    expect(convertQuantity('0.3', '1', '0.1', 0)).toBe('3');
    expect(convertQuantity('3', '1', '3', 6)).toBe('1.000000');
  });

  it('answers null for a quantity or factor that is not valid', () => {
    expect(convertQuantity('x', '1', '1', 0)).toBeNull();
    expect(convertQuantity('1', '1', '0', 0)).toBeNull();
  });
});

describe('toBaseQuantity', () => {
  it('turns packaging into base units', () => {
    expect(toBaseQuantity('3', '20', 3)).toBe('60.000');
    expect(toBaseQuantity('2', '0.5', 0)).toBe('1');
    expect(toBaseQuantity('2', '0', 0)).toBeNull();
  });
});

describe('cleanFactor', () => {
  it('trims zeros and refuses non-positive numbers', () => {
    expect(cleanFactor('12.500')).toEqual({ ok: true, value: '12.5' });
    expect(cleanFactor('100')).toEqual({ ok: true, value: '100' });
    expect(cleanFactor('0').ok).toBe(false);
  });
});

describe('checkPackagings', () => {
  const row = (over = {}) => ({
    unitId: 'crate',
    qtyPerBase: '20',
    weightKg: '',
    isSalesDefault: false,
    isPurchaseDefault: false,
    ...over,
  });

  it('accepts alternate units and cleans their numbers', () => {
    const r = checkPackagings([row({ weightKg: '21.50' })], 'kg');
    expect(r).toEqual({
      ok: true,
      value: [
        {
          unitId: 'crate',
          qtyPerBase: '20',
          weightKg: '21.5',
          isSalesDefault: false,
          isPurchaseDefault: false,
        },
      ],
    });
  });

  it('refuses the base unit, repeats, missing units, bad numbers and two defaults', () => {
    expect(checkPackagings([row({ unitId: 'kg' })], 'kg').ok).toBe(false);
    expect(checkPackagings([row(), row()], 'kg').ok).toBe(false);
    expect(checkPackagings([row({ unitId: '' })], 'kg').ok).toBe(false);
    expect(checkPackagings([row({ qtyPerBase: '0' })], 'kg').ok).toBe(false);
    expect(checkPackagings([row({ weightKg: '-1' })], 'kg').ok).toBe(false);
    expect(checkPackagings([row({ weightKg: '1.23456' })], 'kg').ok).toBe(false);
    expect(
      checkPackagings(
        [row({ isSalesDefault: true }), row({ unitId: 'bag', isSalesDefault: true })],
        'kg',
      ).ok,
    ).toBe(false);
    expect(
      checkPackagings(
        [row({ isPurchaseDefault: true }), row({ unitId: 'bag', isPurchaseDefault: true })],
        'kg',
      ).ok,
    ).toBe(false);
    expect(
      checkPackagings(
        Array.from({ length: 21 }, (_, i) => row({ unitId: `u${String(i)}` })),
        'kg',
      ).ok,
    ).toBe(false);
  });
});

describe('changesMeaning', () => {
  const unit: UnitFields = {
    code: 'G',
    name: 'Gram',
    description: null,
    symbol: null,
    kind: 'mass',
    baseUnitId: 'kg',
    factorToBase: '0.001',
    decimals: 0,
    internationalCode: null,
    etimsCode: null,
  };

  it('is true for a change of family, base or factor, however the factor is written', () => {
    expect(changesMeaning(unit, { ...unit, kind: 'volume' })).toBe(true);
    expect(changesMeaning(unit, { ...unit, baseUnitId: null, factorToBase: '1' })).toBe(true);
    expect(changesMeaning(unit, { ...unit, factorToBase: '0.002' })).toBe(true);
    expect(changesMeaning(unit, { ...unit, factorToBase: '0.0010' })).toBe(false);
    expect(changesMeaning(unit, { ...unit, name: 'Grams', symbol: 'g', decimals: 2 })).toBe(false);
  });

  it('round-trips through a draft', () => {
    const r = checkUnit(draftFromUnit(unit));
    expect(r.ok && r.value).toEqual(unit);
  });
});

describe('usageWords', () => {
  it('says where a unit is used', () => {
    expect(
      usageWords({ products: 0, packagings: 0, derivedUnits: 0, documentLines: 0 }),
    ).toBeNull();
    expect(usageWords({ products: 1, packagings: 2, derivedUnits: 3, documentLines: 0 })).toBe(
      'Used by 1 product, 2 product packagings, 3 other units',
    );
  });
});

describe('quantityProblem', () => {
  it('says in words why a quantity does not fit the unit it is counted in', () => {
    expect(quantityProblem(3, 0, 'Piece', 'Stock')).toBeNull();
    expect(quantityProblem(2.5, 0, 'Piece', 'Stock')).toBe(
      'Stock must be a whole number: it is counted in Piece.',
    );
    expect(quantityProblem(1.2345, 3, 'Kilogram', 'Stock')).toBe(
      'Stock can have at most 3 decimals: it is counted in Kilogram.',
    );
    expect(quantityProblem(1.25, 1, 'Litre', 'Stock')).toBe(
      'Stock can have at most 1 decimal: it is counted in Litre.',
    );
    expect(quantityProblem(Number.NaN, 0, 'Piece', 'Stock')).toBe('Stock must be a number.');
  });
});

describe('quantityStep', () => {
  it('is the smallest step an input for the unit takes', () => {
    expect([0, 1, 2, 3, 6].map(quantityStep)).toEqual(['1', '0.1', '0.01', '0.001', '0.001']);
  });
});

describe('lineInBase', () => {
  it('turns what was typed in a unit into the base unit, exactly', () => {
    expect(lineInBase(3, '20', 3)).toEqual({ ok: true, value: 60 });
    expect(lineInBase(100, '12', 0)).toEqual({ ok: true, value: 1200 });
    expect(lineInBase(0.5, '20', 3)).toEqual({ ok: true, value: 10 });
    expect(lineInBase(0.1, '3', 3)).toEqual({ ok: true, value: 0.3 });
  });

  it('refuses a quantity that comes to a fraction the base unit cannot hold', () => {
    const r = lineInBase(1.5, '1', 0);
    expect(!r.ok && r.error).toMatch(/allows only 0 decimals/);
    expect(lineInBase(0, '20', 3).ok).toBe(false);
    expect(lineInBase(-1, '20', 3).ok).toBe(false);
    expect(lineInBase(1, '0', 3).ok).toBe(false);
  });
});

describe('how a line shows', () => {
  const base = { quantity: 60, unitPrice: 75, total: 4500 };

  it('shows what was typed: the quantity in its unit and the price for one of it', () => {
    const line = { ...base, unitCode: 'CRATE', enteredQuantity: 3, enteredUnitPrice: 1500 };
    expect(lineDisplay(line)).toEqual({ quantity: 3, unit: 'CRATE', unitPrice: 1500 });
    expect(quantityWords(line)).toBe('3 CRATE');
  });

  it('works the price for one out from the total when it was not kept', () => {
    expect(
      lineDisplay({ ...base, unitCode: 'CRATE', enteredQuantity: 3, enteredUnitPrice: null })
        .unitPrice,
    ).toBe(1500);
  });

  it('shows a base unit line as it is, with its unit when it has one', () => {
    expect(quantityWords({ ...base, unitCode: 'KG' })).toBe('60 KG');
    expect(quantityWords(base)).toBe('60');
    expect(lineDisplay({ ...base, unitCode: 'KG' }).unitPrice).toBe(75);
  });

  it('reads a saved row whose numbers are text', () => {
    expect(
      lineFromRow({
        quantity: '60.000',
        unitPrice: '75.0000',
        lineAmount: '4500.00',
        unitCode: 'CRATE',
        enteredQuantity: 3,
        enteredUnitPrice: '1500.0000',
      }),
    ).toEqual({
      quantity: 60,
      unitPrice: 75,
      total: 4500,
      unitCode: 'CRATE',
      enteredQuantity: 3,
      enteredUnitPrice: 1500,
    });
    expect(lineFromRow({ quantity: 2, unitPrice: 5, totalPrice: 10 }).total).toBe(10);
  });
});
