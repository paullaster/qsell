import { describe, expect, it } from 'vitest';
import { resolveStoredPicks, storedPicks, checkPackageBasket, checkPackageLine, optionsToShow, packageAvailable, selectionSentence, wordsList, type LineStock, type ShopPackage } from './package-shop';

const lunch: ShopPackage = {
  productId: 'lunch',
  name: 'Express lunch',
  basePrice: 500,
  pricingMode: 'base_plus_differences',
  shortStockMode: 'hide',
  version: 1,
  slots: [
    {
      id: 'fish', name: 'Fish', helpText: '', minPicks: 1, maxPicks: 1, allowRepeats: false, included: false,
      options: [
        { id: 'small', productId: 'p-small', name: 'Small fish', quantity: 1, difference: 0, price: 300, isDefault: true },
        { id: 'large', productId: 'p-large', name: 'Large fish', quantity: 1, difference: 150, price: 450, isDefault: false },
      ],
    },
    {
      id: 'starch', name: 'Starch', helpText: '', minPicks: 1, maxPicks: 1, allowRepeats: false, included: false,
      options: [
        { id: 'ugali', productId: 'p-ugali', name: 'Ugali', quantity: 1, difference: 0, price: 50, isDefault: true },
        { id: 'brown', productId: 'p-brown', name: 'Brown ugali', quantity: 1, difference: 30, price: 80, isDefault: false },
      ],
    },
    {
      id: 'veg', name: 'Vegetables', helpText: '', minPicks: 1, maxPicks: 2, allowRepeats: false, included: false,
      options: [
        { id: 'sukuma', productId: 'p-sukuma', name: 'Sukuma', quantity: 1, difference: 0, price: 40, isDefault: true },
        { id: 'cabbage', productId: 'p-cabbage', name: 'Cabbage', quantity: 1, difference: 10, price: 50, isDefault: false },
      ],
    },
  ],
};

const slotAt = (pkg: ShopPackage, index: number) => {
  const slot = pkg.slots[index];
  if (slot === undefined) throw new Error('no such slot');
  return slot;
};

const plenty: LineStock = {
  free: new Map([['p-small', 10], ['p-large', 10], ['p-ugali', 10], ['p-brown', 10], ['p-sukuma', 10], ['p-cabbage', 10]]),
  unlimited: new Set(),
};
const line = (picks: [string, string][], servings = 1) => ({ productId: 'lunch', servings, picks: picks.map(([slotId, optionId]) => ({ slotId, optionId, count: 1 })) });

describe('wordsList and the sentence', () => {
  it('joins with commas and and', () => {
    expect(wordsList([])).toBe('');
    expect(wordsList(['a'])).toBe('a');
    expect(wordsList(['a', 'b'])).toBe('a and b');
    expect(wordsList(['a', 'b', 'c'])).toBe('a, b and c');
  });
  it('names every pick, with a count when it is more than one', () => {
    const names = new Map([['x', 'Sukuma']]);
    const pick = { slotId: 's', optionId: 'x', count: 2, option: {} as never };
    expect(selectionSentence('Lunch', [pick], names)).toBe('Lunch: 2 × Sukuma');
  });
});

describe('checking one line', () => {
  it('prices the base plus the differences and multiplies by the servings', () => {
    const result = checkPackageLine(lunch, line([['fish', 'large'], ['starch', 'brown'], ['veg', 'sukuma'], ['veg', 'cabbage']], 3), plenty);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.servingPrice).toBe(500 + 150 + 30 + 10);
      expect(result.total).toBe(690 * 3);
      expect(result.summary).toBe('Express lunch: Large fish, Brown ugali, Sukuma and Cabbage');
    }
  });

  it('gives the same key however the picks are ordered', () => {
    const a = checkPackageLine(lunch, line([['fish', 'small'], ['starch', 'ugali'], ['veg', 'sukuma'], ['veg', 'cabbage']]), plenty);
    const b = checkPackageLine(lunch, line([['veg', 'cabbage'], ['veg', 'sukuma'], ['starch', 'ugali'], ['fish', 'small']]), plenty);
    expect(a.ok && b.ok && a.key === b.key).toBe(true);
  });

  it('refuses servings that are not whole or are out of range', () => {
    for (const servings of [0, -1, 1.5, 1001, Number.NaN]) {
      const result = checkPackageLine(lunch, line([['fish', 'small'], ['starch', 'ugali'], ['veg', 'sukuma']], servings), plenty);
      expect(result.ok).toBe(false);
    }
  });

  it('refuses a choice from another package, a missing slot and too many picks', () => {
    expect(checkPackageLine(lunch, line([['fish', 'nope'], ['starch', 'ugali'], ['veg', 'sukuma']]), plenty).ok).toBe(false);
    const missing = checkPackageLine(lunch, line([['fish', 'small'], ['veg', 'sukuma']]), plenty);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.problems.join(' ')).toContain('Starch');
    expect(checkPackageLine(lunch, line([['fish', 'small'], ['fish', 'large'], ['starch', 'ugali'], ['veg', 'sukuma']]), plenty).ok).toBe(false);
  });

  it('says which option is short and for how many servings', () => {
    const stock: LineStock = { ...plenty, free: new Map([...plenty.free, ['p-brown', 2]]) };
    const result = checkPackageLine(lunch, line([['fish', 'small'], ['starch', 'brown'], ['veg', 'sukuma']], 3), stock);
    expect(result).toEqual({ ok: false, problems: ['Brown ugali is sold out for 3 servings.'] });
    const none = checkPackageLine(lunch, line([['fish', 'small'], ['starch', 'brown'], ['veg', 'sukuma']]), { ...plenty, free: new Map() });
    expect(none.ok).toBe(false);
  });

  it('never counts an option that is not stock-managed', () => {
    const stock: LineStock = { free: new Map(), unlimited: new Set(['p-small', 'p-ugali', 'p-sukuma']) };
    expect(checkPackageLine(lunch, line([['fish', 'small'], ['starch', 'ugali'], ['veg', 'sukuma']], 50), stock).ok).toBe(true);
  });

  it('counts a product used by two picks once per pick', () => {
    const shared: ShopPackage = {
      ...lunch,
      slots: [{ ...slotAt(lunch, 2), options: [{ id: 'a', productId: 'same', name: 'Greens', quantity: 1, difference: 0, price: 1, isDefault: true }, { id: 'b', productId: 'same', name: 'Greens again', quantity: 1, difference: 0, price: 1, isDefault: false }] }],
    };
    const stock: LineStock = { free: new Map([['same', 1]]), unlimited: new Set() };
    const two = checkPackageLine(shared, { productId: 'lunch', servings: 1, picks: [{ slotId: 'veg', optionId: 'a', count: 1 }, { slotId: 'veg', optionId: 'b', count: 1 }] }, stock);
    expect(two.ok).toBe(false);
  });
});

describe('summed pricing', () => {
  it('adds each pick own price and refuses an option with no price', () => {
    const summed: ShopPackage = { ...lunch, pricingMode: 'summed' };
    const ok = checkPackageLine(summed, line([['fish', 'small'], ['starch', 'ugali'], ['veg', 'sukuma']]), plenty);
    expect(ok.ok && ok.servingPrice).toBe(300 + 50 + 40);
    const unpriced: ShopPackage = { ...summed, slots: summed.slots.map((s) => (s.id === 'fish' ? { ...s, options: s.options.map((o) => ({ ...o, price: null })) } : s)) };
    expect(checkPackageLine(unpriced, line([['fish', 'small'], ['starch', 'ugali'], ['veg', 'sukuma']]), plenty).ok).toBe(false);
  });
});

describe('a basket of lines', () => {
  it('lets a second line see what the first took, so two lunches do not share the last portion', () => {
    const stock: LineStock = { free: new Map([...plenty.free, ['p-brown', 1]]), unlimited: new Set() };
    const same = line([['fish', 'small'], ['starch', 'brown'], ['veg', 'sukuma']]);
    const results = checkPackageBasket(new Map([['lunch', lunch]]), [same, same], stock);
    expect(results[0]?.ok).toBe(true);
    expect(results[1]?.ok).toBe(false);
  });
  it('says so when the package has gone', () => {
    const results = checkPackageBasket(new Map(), [line([['fish', 'small']])], plenty);
    expect(results[0]).toEqual({ ok: false, problems: ['This package is not available any more.'] });
  });
});

describe('what stock lets the shopper see', () => {
  const available = new Set(['small', 'ugali', 'sukuma']);
  it('hides short options by default', () => {
    const rows = optionsToShow(slotAt(lunch, 1), available, 'hide');
    expect(rows.map((r) => r.option.id)).toEqual(['ugali']);
  });
  it('greys them out, or suggests the nearest', () => {
    const grey = optionsToShow(slotAt(lunch, 1), available, 'disable');
    expect(grey.map((r) => [r.option.id, r.available, r.suggestion])).toEqual([['ugali', true, null], ['brown', false, null]]);
    const suggest = optionsToShow(slotAt(lunch, 1), available, 'substitute');
    expect(suggest[1]?.suggestion).toBe('ugali');
  });
  it('makes the package unavailable when a required slot has nothing left', () => {
    expect(packageAvailable(lunch, available)).toBe(true);
    expect(packageAvailable(lunch, new Set(['small', 'sukuma']))).toBe(false);
  });
  it('does not mind an optional slot with nothing left', () => {
    const optional: ShopPackage = { ...lunch, slots: [...lunch.slots, { id: 'extra', name: 'Extras', helpText: '', minPicks: 0, maxPicks: 2, allowRepeats: false, included: false, options: [{ id: 'e', productId: 'p-e', name: 'Chilli', quantity: 1, difference: 20, price: 20, isDefault: false }] }] };
    expect(packageAvailable(optional, available)).toBe(true);
  });
});

describe('a selection kept by a quote', () => {
  const raw = [{ slotId: 'fish', optionId: 'large', count: 1 }, { slotId: 'starch', optionId: 'brown', count: 1 }, { slotId: 'veg', optionId: 'sukuma', count: 1 }];
  it('is kept by slot name and part, and found again by them', () => {
    const stored = storedPicks(lunch, raw);
    expect(stored).toEqual([
      { slotName: 'Fish', productId: 'p-large', name: 'Large fish', count: 1 },
      { slotName: 'Starch', productId: 'p-brown', name: 'Brown ugali', count: 1 },
      { slotName: 'Vegetables', productId: 'p-sukuma', name: 'Sukuma', count: 1 },
    ]);
    expect(resolveStoredPicks(lunch, stored)).toEqual({ ok: true, picks: raw });
  });
  it('still resolves when the package was changed and its option ids are new', () => {
    const renewed: ShopPackage = { ...lunch, slots: lunch.slots.map((s) => ({ ...s, id: `${s.id}-2`, options: s.options.map((o) => ({ ...o, id: `${o.id}-2` })) })) };
    expect(resolveStoredPicks(renewed, storedPicks(lunch, raw))).toEqual({ ok: true, picks: [{ slotId: 'fish-2', optionId: 'large-2', count: 1 }, { slotId: 'starch-2', optionId: 'brown-2', count: 1 }, { slotId: 'veg-2', optionId: 'sukuma-2', count: 1 }] });
  });
  it('names what the package no longer offers', () => {
    const without: ShopPackage = { ...lunch, slots: lunch.slots.map((s) => ({ ...s, options: s.options.filter((o) => o.id !== 'brown') })) };
    expect(resolveStoredPicks(without, storedPicks(lunch, raw))).toEqual({ ok: false, problems: ['Brown ugali is no longer offered in Starch.'] });
  });
});
