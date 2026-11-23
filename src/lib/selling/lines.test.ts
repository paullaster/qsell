import { describe, expect, it } from 'vitest';
import { lineShown, listEstimate, payloadLine, pricedFor, quantityOf, readTypedPrice, readyToPlace, type DocLine } from './lines';

const line = (over: Partial<DocLine> = {}): DocLine => ({ key: 'a', productId: 'p1', name: 'Solar panel', quantity: '2', listPrice: 1000, ...over });

describe('quantityOf', () => {
  it('reads a number above nothing and nothing else', () => {
    expect(quantityOf(line({ quantity: '2.5' }))).toBe(2.5);
    for (const q of ['', ' ', '0', '-1', 'abc']) expect(quantityOf(line({ quantity: q }))).toBe(0);
  });
});

describe('payloadLine', () => {
  it('sends ids, the count and only what was typed', () => {
    expect(payloadLine(line())).toEqual({ productId: 'p1', quantity: 2 });
    expect(payloadLine(line({ price: 900 }))).toEqual({ productId: 'p1', quantity: 2, unitPrice: 900 });
    expect(payloadLine(line({ discount: { kind: 'percent', value: 10 } }))).toEqual({ productId: 'p1', quantity: 2, discount: { kind: 'percent', value: 10 } });
  });
  it('never sends a price or discount for a package', () => {
    const pkg = line({ price: 5, discount: { kind: 'amount', value: 1 }, package: { picks: [], note: '', summary: 'Box' } });
    expect(payloadLine(pkg)).toEqual({ productId: 'p1', quantity: 2, package: { picks: [], note: '' } });
  });
});

describe('pricedFor', () => {
  const priced = { subtotal: 0, tax: 0, total: 0, lines: [{ productId: 'p1', quantity: 2, unitPrice: 900, lineTotal: 1800 }, { productId: 'p2', quantity: 1, unitPrice: 50, lineTotal: 50 }] };
  it('matches by place, then by product and quantity', () => {
    expect(pricedFor(priced, [line(), line({ key: 'b', productId: 'p2', quantity: '1' })])).toEqual(priced.lines);
    expect(pricedFor(priced, [line({ key: 'b', productId: 'p2', quantity: '1' }), line()])).toEqual([priced.lines[1], priced.lines[0]]);
  });
  it('gives nothing for a line the server did not price, or before it priced anything', () => {
    expect(pricedFor(priced, [line({ quantity: '7' })])).toEqual([null]);
    expect(pricedFor(null, [line()])).toEqual([null]);
  });
});

describe('lineShown', () => {
  it('shows the list price and its total before the server answers', () => {
    expect(lineShown(line(), null)).toMatchObject({ unit: 1000, total: 2000, was: null, changed: null });
  });
  it('shows the server price, and what it was, when a price or discount changed it', () => {
    expect(lineShown(line({ price: 900 }), { productId: 'p1', quantity: 2, unitPrice: 900, lineTotal: 1800 })).toMatchObject({ unit: 900, total: 1800, was: 1000, changed: 'price' });
    expect(lineShown(line({ discount: { kind: 'percent', value: 10 } }), { productId: 'p1', quantity: 2, unitPrice: 900, lineTotal: 1800 })).toMatchObject({ unit: 900, was: 1000, changed: 'discount' });
  });
  it('has no total for a quantity that is not a number', () => {
    expect(lineShown(line({ quantity: '' }), null).total).toBeNull();
  });
});

describe('listEstimate and readyToPlace', () => {
  it('adds list prices times quantities, leaving out packages', () => {
    expect(listEstimate([line(), line({ key: 'b', quantity: '1', listPrice: 50 }), line({ key: 'c', package: { picks: [], note: '', summary: '' } })])).toBe(2050);
    expect(listEstimate([line({ listPrice: null })])).toBeNull();
  });
  it('needs a customer and every quantity above nothing', () => {
    expect(readyToPlace(true, [line()])).toBe(true);
    expect(readyToPlace(false, [line()])).toBe(false);
    expect(readyToPlace(true, [])).toBe(false);
    expect(readyToPlace(true, [line({ quantity: '0' })])).toBe(false);
  });
});

describe('readTypedPrice', () => {
  it('reads a price to the cent and refuses anything else', () => {
    expect(readTypedPrice('1,200')).toBeNull();
    expect(readTypedPrice('1200.456')).toBe(1200.46);
    for (const t of ['', '0', '-5', 'x']) expect(readTypedPrice(t)).toBeNull();
  });
});
