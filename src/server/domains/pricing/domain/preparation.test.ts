import { describe, expect, it } from 'vitest';
import { buildSheet, picksWords, type PreparationRow } from './preparation';

const pick = (slotName: string, productId: string, productName: string, count = 1, quantity = 1, sortOrder = 0) => ({ slotName, productId, productName, count, quantity, sortOrder });
const row = (over: Partial<PreparationRow> & { n: string }): PreparationRow => ({
  instanceId: `i-${over.n}`,
  orderId: `o-${over.n}`,
  orderNumber: `ORD-${over.n}`,
  customerName: `Customer ${over.n}`,
  paymentStatus: 'paid',
  packageProductId: 'lunch',
  packageName: 'Express lunch',
  servings: 1,
  note: '',
  slotName: null,
  slotStartsAt: null,
  picks: [pick('Fish', 'medium', 'Medium fish', 1, 1, 0), pick('Starch', 'ugali', 'Ugali', 1, 1, 1)],
  ...over,
});

describe('the choices as words', () => {
  it('reads in the order the package asks, with a count when it is more than one', () => {
    expect(picksWords([pick('Veg', 'k', 'Sukuma', 2, 1, 2), pick('Fish', 'f', 'Large fish', 1, 1, 0), pick('Starch', 'u', 'Brown ugali', 1, 1, 1)])).toBe('Large fish, Brown ugali and 2 × Sukuma');
    expect(picksWords([])).toBe('');
  });
});

describe('a note on a selection', () => {
  it('stays with its own selection on the sheet, and selections with other notes stay separate lines', () => {
    const sheet = buildSheet([row({ n: '1', note: 'no pepper' }), row({ n: '2' })]);
    const lines = sheet.groups[0]?.packages[0]?.selections ?? [];
    expect(lines.map((l) => [l.orderNumber, l.note])).toEqual([['ORD-1', 'no pepper'], ['ORD-2', '']]);
  });
});

describe('the sheet for a day', () => {
  it('totals what must be made: servings of each package, and portions and units of each part', () => {
    const sheet = buildSheet([
      row({ n: '1', servings: 3 }),
      row({ n: '2', servings: 9, picks: [pick('Fish', 'medium', 'Medium fish', 1, 1, 0), pick('Starch', 'brown', 'Brown ugali', 1, 2, 1)] }),
    ]);
    expect(sheet.totals.servings).toBe(12);
    expect(sheet.totals.packages).toEqual([{ packageProductId: 'lunch', packageName: 'Express lunch', servings: 12 }]);
    expect(sheet.totals.parts).toEqual([
      { productId: 'medium', productName: 'Medium fish', portions: 12, units: 12 },
      { productId: 'brown', productName: 'Brown ugali', portions: 9, units: 18 },
      { productId: 'ugali', productName: 'Ugali', portions: 3, units: 3 },
    ]);
    expect(sheet.orders).toBe(2);
  });

  it('counts a pick chosen more than once for every serving', () => {
    const sheet = buildSheet([row({ n: '1', servings: 4, picks: [pick('Veg', 'sukuma', 'Sukuma', 2, 0.5, 0)] })]);
    expect(sheet.totals.parts).toEqual([{ productId: 'sukuma', productName: 'Sukuma', portions: 8, units: 4 }]);
  });

  it('groups by delivery slot, earliest first and orders with no slot last, then by package, then by order', () => {
    const sheet = buildSheet([
      row({ n: '3', slotName: 'Afternoon', slotStartsAt: '14:00' }),
      row({ n: '2' }),
      row({ n: '1', slotName: 'Lunch time', slotStartsAt: '12:00' }),
      row({ n: '4', slotName: 'Lunch time', slotStartsAt: '12:00', packageProductId: 'breakfast', packageName: 'Breakfast box' }),
      row({ n: '0', slotName: 'Lunch time', slotStartsAt: '12:00' }),
    ]);
    expect(sheet.groups.map((g) => g.slotName)).toEqual(['Lunch time', 'Afternoon', null]);
    expect(sheet.groups[0]?.packages.map((p) => p.packageName)).toEqual(['Breakfast box', 'Express lunch']);
    expect(sheet.groups[0]?.packages[1]?.selections.map((s) => s.orderNumber)).toEqual(['ORD-0', 'ORD-1']);
    expect(sheet.groups[0]?.servings).toBe(3);
  });

  it('keeps identical selections of different orders as separate lines', () => {
    const sheet = buildSheet([row({ n: '1' }), row({ n: '2' })]);
    expect(sheet.groups[0]?.packages[0]?.selections).toHaveLength(2);
    expect(sheet.totals.parts[0]?.portions).toBe(2);
  });

  it('is empty for no selections', () => {
    expect(buildSheet([])).toEqual({ groups: [], totals: { packages: [], parts: [], servings: 0 }, orders: 0 });
  });
});
