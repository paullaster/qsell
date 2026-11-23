import { describe, expect, it } from 'vitest';
import { keypad, lineDiscount, parseReceiptDiscount, parseTillMode, payState, quickCash, stepQuantity } from './till-rules';

describe('till rules', () => {
  it('reads only the two display modes', () => {
    expect(parseTillMode('admin')).toBe('admin');
    expect(parseTillMode('fullscreen')).toBe('fullscreen');
    expect(parseTillMode('kiosk')).toBeNull();
    expect(parseTillMode(undefined)).toBeNull();
  });

  it('offers the exact amount, then rounder amounts above it, each different', () => {
    expect(quickCash(1350)).toEqual([1350, 1400, 1500, 2000, 5000]);
    expect(quickCash(500)).toEqual([500, 600, 1000, 2000, 5000]);
    expect(quickCash(0)).toEqual([]);
    expect(quickCash(Number.NaN)).toEqual([]);
    const some = quickCash(199.5);
    expect(some[0]).toBe(199.5);
    expect(new Set(some).size).toBe(some.length);
    expect(some.every((n) => n >= 199.5)).toBe(true);
  });

  it('builds an amount from keys: digits, one point, two decimals, back and clear', () => {
    let v = '';
    for (const k of ['1', '2', '00']) v = keypad(v, k);
    expect(v).toBe('1200');
    expect(keypad(v, 'back')).toBe('120');
    expect(keypad('', '.')).toBe('0.');
    expect(keypad('0.5', '.')).toBe('0.5');
    expect(keypad('12.34', '5')).toBe('12.34');
    expect(keypad('12.3', '4')).toBe('12.34');
    expect(keypad('0', '7')).toBe('7');
    expect(keypad('123456789', '1')).toBe('123456789');
    expect(keypad('99', 'clear')).toBe('');
    expect(keypad('9', 'x')).toBe('9');
  });

  it('steps a quantity by one and never below one', () => {
    expect(stepQuantity(1, -1)).toBe(1);
    expect(stepQuantity(1, 1)).toBe(2);
    expect(stepQuantity(2.5, 1)).toBe(3.5);
    expect(stepQuantity(99999, 1)).toBe(99999);
  });

  it('says what is left, exact, or the change', () => {
    expect(payState(null, 100)).toEqual({ kind: 'nothing' });
    expect(payState(500, 0)).toEqual({ kind: 'nothing' });
    expect(payState(500, 300)).toEqual({ kind: 'short', left: 200 });
    expect(payState(500, 500)).toEqual({ kind: 'exact' });
    expect(payState(499.9, 1000)).toEqual({ kind: 'change', change: 500.1 });
  });
});

describe('discounts on the receipt', () => {
  it('reads only the three choices', () => {
    for (const ok of ['hidden', 'total', 'per_item'] as const) expect(parseReceiptDiscount(ok)).toBe(ok);
    for (const bad of ['', 'all', 'TOTAL', null, undefined, 3]) expect(parseReceiptDiscount(bad)).toBeNull();
  });

  const trace = (extra: Record<string, unknown>) => ({ engineVersion: 1, at: '', inputs: { productId: 'p', quantity: 1, currency: 'KES' }, candidates: [], steps: [], source: 'price_list', unitPrice: 100, lineTotal: 100, ...extra }) as never;

  it('is what a counter discount took off the price of one, times the quantity, less what was charged', () => {
    expect(lineDiscount(2, 180, trace({ counterDiscount: { kind: 'percent', value: 10, before: 100, perUnit: 10 } }))).toBe(20);
    expect(lineDiscount(3, 255, trace({ counterDiscount: { kind: 'amount', value: 15, before: 100, perUnit: 15 } }))).toBe(45);
  });

  it('is what the discount rules took off when they gave one', () => {
    expect(lineDiscount(2, 170, trace({ discounts: { unitPriceBefore: 100, lineTotalBefore: 200, applied: [], trimmed: 0, considered: [] } }))).toBe(30);
    expect(lineDiscount(2, 200, trace({ discounts: { unitPriceBefore: 100, lineTotalBefore: 200, applied: [], trimmed: 0, considered: [] } }))).toBe(0);
  });

  it('is nothing for a line with no discount, a price only changed, no record, or a total above what it was', () => {
    expect(lineDiscount(2, 200, trace({}))).toBe(0);
    expect(lineDiscount(2, 160, trace({}))).toBe(0);
    expect(lineDiscount(2, 200, null)).toBe(0);
    expect(lineDiscount(2, 250, trace({ counterDiscount: { kind: 'percent', value: 10, before: 100, perUnit: 10 } }))).toBe(0);
  });
});
