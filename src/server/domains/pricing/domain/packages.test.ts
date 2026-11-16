import { describe, expect, it } from 'vitest';
import {
  belowCostWhenCheapest,
  canonicalSelection,
  cheapestSelection,
  checkPackage,
  orderingProblem,
  packageAvailability,
  packageParts,
  servingCost,
  servingPrice,
  type OrderingRules,
  type PackageDef,
  type PackageOptionDef,
} from './packages';

const option = (id: string, productId: string, over: Partial<PackageOptionDef> = {}): PackageOptionDef => ({ id, productId, quantity: 1, difference: 0, price: 0, cost: 0, weight: null, isDefault: false, ...over });

/** The express lunch: one fish of three sizes, ugali or brown ugali, one or two vegetables, optional extras. */
const lunch = (over: Partial<PackageDef> = {}): PackageDef => ({
  productId: 'lunch',
  pricingMode: 'base_plus_differences',
  allocation: 'list_price',
  slots: [
    { id: 'fish', name: 'Fish', minPicks: 1, maxPicks: 1, allowRepeats: false, included: false, options: [option('small', 'fish-s', { price: 300, cost: 150 }), option('medium', 'fish-m', { difference: 100, price: 400, cost: 200, isDefault: true }), option('large', 'fish-l', { difference: 200, price: 500, cost: 260 })] },
    { id: 'starch', name: 'Starch', minPicks: 1, maxPicks: 1, allowRepeats: false, included: false, options: [option('ugali', 'ugali', { price: 50, cost: 20, isDefault: true }), option('brown', 'brown-ugali', { difference: 30, price: 80, cost: 35 })] },
    { id: 'veg', name: 'Vegetables', minPicks: 1, maxPicks: 2, allowRepeats: false, included: false, options: [option('sukuma', 'sukuma', { price: 40, cost: 15 }), option('cabbage', 'cabbage', { price: 40, cost: 15 }), option('spinach', 'spinach', { difference: 10, price: 50, cost: 20 })] },
    { id: 'extra', name: 'Extras', minPicks: 0, maxPicks: 3, allowRepeats: true, included: false, options: [option('kachumbari', 'kachumbari', { difference: 30, price: 30, cost: 10 })] },
  ],
  ...over,
});


const slotAt = (def: PackageDef, index: number) => {
  const found = def.slots[index];
  if (found === undefined) throw new Error(`no slot ${String(index)}`);
  return found;
};
const optionAt = (def: PackageDef, slot: number, index: number) => {
  const found = slotAt(def, slot).options[index];
  if (found === undefined) throw new Error(`no option ${String(index)}`);
  return found;
};

const pick = (slotId: string, optionId: string, count = 1) => ({ slotId, optionId, count });
const okSelection = (def: PackageDef, raw: ReturnType<typeof pick>[], note = '') => {
  const result = canonicalSelection(def, raw, note);
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result;
};

describe('checkPackage', () => {
  it('accepts the express lunch', () => {
    expect(checkPackage(lunch())).toEqual([]);
  });
  it('refuses a package with no slots, a slot with no options, and a least above the most', () => {
    expect(checkPackage(lunch({ slots: [] })).map((p) => p.path)).toContain('slots');
    const bad = lunch();
    slotAt(bad, 0).options = [];
    slotAt(bad, 1).minPicks = 3;
    const messages = checkPackage(bad).map((p) => p.message).join(' | ');
    expect(messages).toMatch(/Fish needs at least one option/);
    expect(messages).toMatch(/Starch: the least cannot be more than the most/);
  });
  it('refuses itself, another package or kit, a duplicate product and a missing product', () => {
    const def = lunch();
    slotAt(def, 0).options.push(option('self', 'lunch'), option('dup', 'fish-s'), option('kit', 'some-kit'), option('gone', 'gone'));
    const messages = checkPackage(def, new Set(['lunch', 'fish-s', 'fish-m', 'fish-l', 'ugali', 'brown-ugali', 'sukuma', 'cabbage', 'spinach', 'kachumbari', 'some-kit']), new Set(['some-kit'])).map((p) => p.message).join(' | ');
    expect(messages).toMatch(/cannot contain itself/);
    expect(messages).toMatch(/another package or a kit/);
    expect(messages).toMatch(/listed twice/);
    expect(messages).toMatch(/no longer exists/);
  });
  it('needs a price on every option in summed mode, and an included slot to have one option', () => {
    const summed = lunch({ pricingMode: 'summed' });
    optionAt(summed, 0, 0).price = null;
    expect(checkPackage(summed).map((p) => p.message).join()).toMatch(/needs a price/);
    const included = lunch();
    slotAt(included, 3).included = true;
    expect(checkPackage(included).map((p) => p.message).join()).toMatch(/included slot has exactly one option/);
  });
});

describe('canonicalSelection', () => {
  const express = [pick('fish', 'medium'), pick('starch', 'brown'), pick('veg', 'sukuma'), pick('veg', 'cabbage')];
  it('accepts a valid choice and gives the same key whatever order it arrived in', () => {
    const a = okSelection(lunch(), express);
    const b = okSelection(lunch(), [...express].reverse());
    expect(a.key).toBe(b.key);
    expect(a.picks.map((p) => p.optionId)).toEqual(['medium', 'brown', 'sukuma', 'cabbage']);
  });
  it('gives different keys for different choices and for a different note', () => {
    const base = okSelection(lunch(), express).key;
    expect(okSelection(lunch(), [pick('fish', 'large'), ...express.slice(1)]).key).not.toBe(base);
    expect(okSelection(lunch(), express, 'no pepper').key).not.toBe(base);
    expect(okSelection(lunch(), express, '  no pepper ').key).toBe(okSelection(lunch(), express, 'no pepper').key);
  });
  it('refuses a choice from another slot, an unknown one, a count of zero, and too few or too many', () => {
    const reasons = (raw: ReturnType<typeof pick>[]) => {
      const r = canonicalSelection(lunch(), raw);
      return r.ok ? '' : r.problems.map((p) => p.message).join(' | ');
    };
    expect(reasons([pick('fish', 'ugali'), ...express.slice(1)])).toMatch(/does not belong/);
    expect(reasons([pick('nope', 'x'), ...express])).toMatch(/does not belong/);
    expect(reasons([pick('fish', 'medium', 0), ...express.slice(1)])).toMatch(/whole number from 1/);
    expect(reasons(express.slice(1))).toMatch(/Choose an option for Fish/);
    expect(reasons([...express, pick('fish', 'large')])).toMatch(/Choose at most 1 for Fish/);
    expect(reasons([...express, pick('veg', 'spinach')])).toMatch(/Choose at most 2 for Vegetables/);
  });
  it('adds up the same option sent twice, so a double tap cannot get past the rules', () => {
    const r = canonicalSelection(lunch(), [pick('fish', 'medium'), pick('fish', 'medium'), ...express.slice(1)]);
    expect(r.ok).toBe(false);
  });
  it('allows repeats only where the slot allows them', () => {
    expect(okSelection(lunch(), [...express, pick('extra', 'kachumbari', 2)]).picks.find((p) => p.slotId === 'extra')?.count).toBe(2);
    expect(canonicalSelection(lunch(), [pick('fish', 'medium', 2), ...express.slice(1)]).ok).toBe(false);
  });
  it('fills in an included slot and refuses a note that is too long', () => {
    const def = lunch();
    def.slots.push({ id: 'plate', name: 'Plate', minPicks: 1, maxPicks: 1, allowRepeats: false, included: true, options: [option('plate', 'plate')] });
    expect(okSelection(def, express).picks.some((p) => p.optionId === 'plate')).toBe(true);
    expect(canonicalSelection(lunch(), express, 'x'.repeat(201)).ok).toBe(false);
  });
});

describe('servingPrice', () => {
  it('adds the differences to the base price', () => {
    const r = okSelection(lunch(), [pick('fish', 'large'), pick('starch', 'brown'), pick('veg', 'spinach'), pick('extra', 'kachumbari', 2)]);
    expect(servingPrice(lunch(), r.picks, 650)).toBe(650 + 200 + 30 + 10 + 60);
  });
  it('sums the options\' own prices in summed mode', () => {
    const def = lunch({ pricingMode: 'summed' });
    const r = okSelection(def, [pick('fish', 'small'), pick('starch', 'ugali'), pick('veg', 'sukuma')]);
    expect(servingPrice(def, r.picks, 999)).toBe(390);
  });
  it('refuses a price below zero and allows a free serving', () => {
    const def = lunch();
    optionAt(def, 0, 0).difference = -700;
    const r = okSelection(def, [pick('fish', 'small'), pick('starch', 'ugali'), pick('veg', 'sukuma')]);
    expect(servingPrice(def, r.picks, 650)).toBeNull();
    expect(servingPrice(def, r.picks, 700)).toBe(0);
  });
  it('has no price in summed mode when an option has none', () => {
    const def = lunch({ pricingMode: 'summed' });
    optionAt(def, 0, 0).price = null;
    const r = okSelection(def, [pick('fish', 'small'), pick('starch', 'ugali'), pick('veg', 'sukuma')]);
    expect(servingPrice(def, r.picks, 0)).toBeNull();
  });
  it('knows what the serving costs', () => {
    const r = okSelection(lunch(), [pick('fish', 'medium'), pick('starch', 'brown'), pick('veg', 'sukuma')]);
    expect(servingCost(r.picks)).toBe(250);
  });
});

describe('packageParts', () => {
  const picks = okSelection(lunch(), [pick('fish', 'medium'), pick('starch', 'brown'), pick('veg', 'sukuma'), pick('veg', 'cabbage')]).picks;
  it('shares the line price over the parts and the shares add up to the cent, whatever the numbers', () => {
    for (const [price, servings] of [[730, 1], [1459.99, 3], [0.01, 7], [0, 2]] as const) {
      const parts = packageParts(lunch(), picks, price, servings);
      expect(parts.reduce((n, p) => Math.round((n + p.amount) * 100) / 100, 0)).toBe(price);
      expect(parts.map((p) => p.quantity)).toEqual([servings, servings, servings, servings]);
    }
  });
  it('in summed mode each part takes exactly its own price', () => {
    const def = lunch({ pricingMode: 'summed' });
    const r = okSelection(def, [pick('fish', 'small'), pick('starch', 'ugali'), pick('veg', 'sukuma')]);
    const parts = packageParts(def, r.picks, servingPrice(def, r.picks, 0) ?? 0, 1);
    expect(Object.fromEntries(parts.map((p) => [p.productId, p.amount]))).toEqual({ 'fish-s': 300, ugali: 50, sukuma: 40 });
  });
  it('makes one part of a product chosen in two slots, and multiplies by the servings and the count', () => {
    const def = lunch();
    slotAt(def, 2).options.push(option('extra-fish', 'fish-m', { price: 400, cost: 200 }));
    const r = okSelection(def, [pick('fish', 'medium'), pick('starch', 'ugali'), pick('veg', 'extra-fish'), pick('extra', 'kachumbari', 2)]);
    const parts = packageParts(def, r.picks, 900, 3);
    expect(parts.filter((p) => p.productId === 'fish-m')).toHaveLength(1);
    expect(parts.find((p) => p.productId === 'fish-m')?.quantity).toBe(6);
    expect(parts.find((p) => p.productId === 'kachumbari')?.quantity).toBe(6);
    expect(parts.reduce((n, p) => Math.round((n + p.amount) * 100) / 100, 0)).toBe(900);
  });
});

describe('packageAvailability', () => {
  const stock = (free: Record<string, number>, taken: Record<string, number> = {}) => ({ free: new Map(Object.entries(free)), taken: new Map(Object.entries(taken)), unlimited: new Set<string>() });
  const plenty = { 'fish-s': 9, 'fish-m': 9, 'fish-l': 9, ugali: 9, 'brown-ugali': 9, sukuma: 9, cabbage: 9, spinach: 9, kachumbari: 9 };
  it('hides an option that is sold out, and shows the others', () => {
    const view = packageAvailability(lunch(), stock({ ...plenty, 'brown-ugali': 0 }), 1, 'hide');
    expect(view.available).toBe(true);
    expect(view.slots.find((s) => s.slotId === 'starch')?.options.map((o) => o.optionId)).toEqual(['ugali']);
  });
  it('can show it greyed out with a reason, or with the nearest one suggested', () => {
    const grey = packageAvailability(lunch(), stock({ ...plenty, 'brown-ugali': 0 }), 1, 'disable').slots.find((s) => s.slotId === 'starch')?.options.find((o) => o.optionId === 'brown');
    expect(grey).toMatchObject({ available: false, reason: 'Sold out for this many servings', suggestion: null });
    const sub = packageAvailability(lunch(), stock({ ...plenty, 'brown-ugali': 0 }), 1, 'substitute').slots.find((s) => s.slotId === 'starch')?.options.find((o) => o.optionId === 'brown');
    expect(sub?.suggestion).toBe('ugali');
  });
  it('makes the package unavailable when a required slot has nothing left, but not an optional one', () => {
    expect(packageAvailability(lunch(), stock({ ...plenty, 'fish-s': 0, 'fish-m': 0, 'fish-l': 0 }), 1, 'hide').available).toBe(false);
    const noExtras = packageAvailability(lunch(), stock({ ...plenty, kachumbari: 0 }), 1, 'hide');
    expect(noExtras.available).toBe(true);
    expect(noExtras.slots.find((s) => s.slotId === 'extra')?.options).toEqual([]);
  });
  it('counts all the servings and what the rest of the basket already holds', () => {
    expect(packageAvailability(lunch(), stock({ ...plenty, ugali: 5 }), 6, 'hide').slots.find((s) => s.slotId === 'starch')?.options.map((o) => o.optionId)).toEqual(['brown']);
    expect(packageAvailability(lunch(), stock({ ...plenty, ugali: 5 }, { ugali: 3 }), 3, 'hide').slots.find((s) => s.slotId === 'starch')?.options.map((o) => o.optionId)).toEqual(['brown']);
  });
  it('is never limited by a part that is not counted', () => {
    const facts = { free: new Map<string, number>(), taken: new Map<string, number>(), unlimited: new Set(['fish-s', 'fish-m', 'fish-l', 'ugali', 'brown-ugali', 'sukuma', 'cabbage', 'spinach', 'kachumbari']) };
    expect(packageAvailability(lunch(), facts, 50, 'hide').available).toBe(true);
  });
});

describe('cheapest selection and the below-cost check', () => {
  it('picks the cheapest options that meet every slot\'s least', () => {
    expect(cheapestSelection(lunch()).map((p) => p.optionId)).toEqual(['small', 'ugali', 'sukuma']);
  });
  it('flags a package whose cheapest selection sells for less than it costs', () => {
    expect(belowCostWhenCheapest(lunch(), 700)).toMatchObject({ below: false, price: 700, cost: 185 });
    expect(belowCostWhenCheapest(lunch(), 150)).toMatchObject({ below: true });
  });
});

describe('orderingProblem', () => {
  const rules = (over: Partial<OrderingRules> = {}): OrderingRules => ({ minServings: null, maxServings: null, noticeMinutes: null, closesDaysBefore: null, closesAtMinute: null, weekdays: [], dailyLimit: null, ...over });
  const now = { date: '2026-11-12', minute: 9 * 60 }; // a Thursday, 09:00
  const noon = (date: string) => ({ date, minute: 12 * 60 });
  it('has nothing to say when there are no rules', () => {
    expect(orderingProblem(rules(), now, null, 1, 0)).toBeNull();
  });
  it('holds the least and most servings', () => {
    expect(orderingProblem(rules({ minServings: 10 }), now, null, 9, 0)).toBe('This package needs at least 10 servings.');
    expect(orderingProblem(rules({ minServings: 10 }), now, null, 10, 0)).toBeNull();
    expect(orderingProblem(rules({ maxServings: 50 }), now, null, 51, 0)).toBe('This package allows at most 50 servings in one order.');
  });
  it('asks for a date when a rule needs one, and refuses a date that has passed', () => {
    expect(orderingProblem(rules({ noticeMinutes: 60 }), now, null, 1, 0)).toBe('Choose the date you need it.');
    expect(orderingProblem(rules(), now, noon('2026-11-11'), 1, 0)).toBe('Choose a date that has not passed.');
  });
  it('holds the notice at its boundary minute', () => {
    const r = rules({ noticeMinutes: 180 });
    expect(orderingProblem(r, now, { date: '2026-11-12', minute: 12 * 60 - 1 }, 1, 0)).toBe('This package needs 3 hours notice.');
    expect(orderingProblem(r, now, { date: '2026-11-12', minute: 12 * 60 }, 1, 0)).toBeNull();
  });
  it('closes orders the day before at a time, at its boundary minute', () => {
    const r = rules({ closesDaysBefore: 1, closesAtMinute: 10 * 60 });
    expect(orderingProblem(r, { date: '2026-11-12', minute: 10 * 60 }, noon('2026-11-13'), 1, 0)).toBeNull();
    expect(orderingProblem(r, { date: '2026-11-12', minute: 10 * 60 + 1 }, noon('2026-11-13'), 1, 0)).toBe('Orders for that date closed 1 day before at 10:00.');
    expect(orderingProblem(r, { date: '2026-11-12', minute: 23 * 60 }, noon('2026-11-20'), 1, 0)).toBeNull();
  });
  it('holds the days of the week (0 is Sunday)', () => {
    const r = rules({ weekdays: [1, 2, 3, 4, 5] });
    expect(orderingProblem(r, now, noon('2026-11-14'), 1, 0)).toBe('This package is not available on that day of the week.'); // Saturday
    expect(orderingProblem(r, now, noon('2026-11-13'), 1, 0)).toBeNull(); // Friday
  });
  it('holds the daily limit and says how many are left', () => {
    const r = rules({ dailyLimit: 100 });
    expect(orderingProblem(r, now, noon('2026-11-13'), 10, 90)).toBeNull();
    expect(orderingProblem(r, now, noon('2026-11-13'), 11, 90)).toBe('Only 10 servings left for that date.');
    expect(orderingProblem(r, now, noon('2026-11-13'), 1, 100)).toBe('This package is fully booked for that date.');
  });
});
