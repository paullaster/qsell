import { describe, expect, it } from 'vitest';
import type { Product } from '@/types/index';
import {
  blankDraft,
  buildCatalogueIndex,
  parseBulkList,
  readDraft,
  searchCatalogue,
} from './catalogue-entry';

const p = (id: string, name: string, sku: string, over: Partial<Product> = {}): Product =>
  ({
    id,
    name,
    sku,
    stockCode: `STK-${sku}`,
    category: 'Solar',
    isSellable: true,
    price: 100,
    ...over,
  }) as Product;

const index = buildCatalogueIndex([
  p('1', 'Solar Panel 550W', 'PAN-550'),
  p('2', 'Hybrid Inverter 5kW', 'INV-5K', { category: 'Inverters', brand: 'Growatt' }),
  p('3', 'Panel Mount Rail', 'RAIL-1'),
  p('4', 'Not for sale', 'X-1', { isSellable: false }),
]);

describe('searchCatalogue', () => {
  it('leaves out what cannot be sold', () => {
    expect(index).toHaveLength(3);
  });
  it('matches every word in any order, on name, code, brand and category', () => {
    expect(searchCatalogue(index, '550w panel').map((e) => e.product.id)).toEqual(['1']);
    expect(searchCatalogue(index, 'growatt').map((e) => e.product.id)).toEqual(['2']);
    expect(searchCatalogue(index, 'stk-rail').map((e) => e.product.id)).toEqual(['3']);
  });
  it('filters by category', () => {
    expect(searchCatalogue(index, '', 'Inverters').map((e) => e.product.id)).toEqual(['2']);
  });
  it('puts an exact code first', () => {
    expect(searchCatalogue(index, 'panel').map((e) => e.product.id)).toEqual(['1', '3']);
    const withCode = buildCatalogueIndex([p('a', 'Panel big', 'PAN'), p('b', 'Panel', 'PANEL')]);
    expect(searchCatalogue(withCode, 'panel')[0]!.product.id).toBe('b');
  });
});

describe('readDraft', () => {
  const prod = { id: '1', price: 100 };
  it('reads a blank draft as one at the list price', () => {
    expect(readDraft(blankDraft, prod)).toEqual({
      entry: { productId: '1', quantity: 1, unitPrice: null, discountPercent: 0 },
    });
  });
  it('reads a typed price and discount', () => {
    expect(readDraft({ quantity: '2.5', price: '90', discount: '5' }, prod)).toEqual({
      entry: { productId: '1', quantity: 2.5, unitPrice: 90, discountPercent: 5 },
    });
  });
  it.each([
    [{ quantity: '', price: '', discount: '' }, /Quantity/],
    [{ quantity: '0', price: '', discount: '' }, /Quantity/],
    [{ quantity: '1', price: '-1', discount: '' }, /Price/],
    [{ quantity: '1', price: '', discount: '101' }, /Discount/],
    [{ quantity: '1', price: '', discount: 'abc' }, /Discount/],
  ])('refuses %j', (draft, message) => {
    const r = readDraft(draft, prod);
    expect('error' in r && r.error).toMatch(message);
  });
  it('needs a typed price when the item has none', () => {
    expect('error' in readDraft(blankDraft, { id: '1', price: undefined })).toBe(true);
    expect('entry' in readDraft({ ...blankDraft, price: '5' }, { id: '1', price: undefined })).toBe(
      true,
    );
  });
});

describe('parseBulkList', () => {
  it('reads codes with quantity, price and discount, in several layouts', () => {
    const r = parseBulkList('PAN-550, 10\nINV-5K\t2\t450\t5\nstk-rail-1;4\nPAN-550 3', index);
    expect(r.problems).toEqual([]);
    expect(
      r.rows.map((x) => [
        x.product.id,
        x.entry.quantity,
        x.entry.unitPrice,
        x.entry.discountPercent,
      ]),
    ).toEqual([
      ['1', 10, null, 0],
      ['2', 2, 450, 5],
      ['3', 4, null, 0],
      ['1', 3, null, 0],
    ]);
  });
  it('skips a header row and blank lines, and strips quotes', () => {
    const r = parseBulkList('SKU,Qty\n\n"PAN-550",5\n', index);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.line).toBe(3);
    expect(r.problems).toEqual([]);
  });
  it('reports what is wrong with a line, by number, and keeps going', () => {
    const r = parseBulkList('PAN-550,2\nNOPE,1\nINV-5K,abc\nRAIL-1,1,,15', index);
    expect(r.rows.map((x) => x.line)).toEqual([1, 4]);
    expect(r.problems.map((x) => [x.line, x.message])).toEqual([
      [2, expect.stringContaining('NOPE')],
      [3, expect.stringContaining('Quantity')],
    ]);
  });
  it('does not treat a first line that is a real code as a header', () => {
    expect(parseBulkList('PAN-550,1', index).rows).toHaveLength(1);
  });
});
