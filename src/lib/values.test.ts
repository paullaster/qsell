import { describe, expect, it } from 'vitest';
import { asRecord, compareValues, emptyToNull, firstNonZero, filledStrings, firstFilled, has, isRecord, nth, orElse, readText, required, toList, trimToNull } from './values';

describe('values', () => {
  it('knows when a text has something in it', () => {
    expect(has('a')).toBe(true);
    expect(has('')).toBe(false);
    expect(has(null)).toBe(false);
    expect(has(undefined)).toBe(false);
    expect(has(' ')).toBe(true);
  });

  it('turns empty or blank text into null, and picks the first filled one', () => {
    expect(emptyToNull('')).toBeNull();
    expect(emptyToNull('x')).toBe('x');
    expect(trimToNull('  ')).toBeNull();
    expect(trimToNull(' x ')).toBe('x');
    expect(trimToNull(undefined)).toBeNull();
    expect(firstFilled(null, '', 'b', 'c')).toBe('b');
    expect(firstFilled(null, undefined)).toBeNull();
    expect(orElse('', 'fallback')).toBe('fallback');
    expect(orElse('a', 'fallback')).toBe('a');
    expect(orElse(null, 3)).toBe(3);
  });

  it('insists on a value where a missing one is a bug', () => {
    expect(required(0)).toBe(0);
    expect(() => required(null, 'the customer')).toThrow('Expected the customer, but there was none.');
    expect(() => required(undefined)).toThrow();
    expect(nth([1, 2, 3], 1)).toBe(2);
    expect(nth([1, 2, 3], -1)).toBe(3);
    expect(() => nth([], 0)).toThrow('position 0');
  });

  it('writes out the first usable text from loose data', () => {
    expect(readText(undefined, '', 'a')).toBe('a');
    expect(readText(null, 12, 'b')).toBe('12');
    expect(readText({}, [], NaN)).toBe('');
    expect(readText(10n)).toBe('10');
    expect(readText()).toBe('');
  });
});


describe('loose objects and lists', () => {
  it('tells an object from everything else, and reads one safely', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('x')).toBe(false);
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord(null)).toEqual({});
    expect(asRecord([1])).toEqual({});
  });

  it('turns one-or-many into a list', () => {
    expect(toList([1, 2])).toEqual([1, 2]);
    expect(toList({ a: 1 })).toEqual([{ a: 1 }]);
    expect(toList(undefined)).toEqual([]);
    expect(toList(null)).toEqual([]);
    expect(toList('')).toEqual([]);
  });
});


describe('ordering helpers', () => {
  it('falls back from one key to the next', () => {
    expect(firstNonZero(0, 0, 3)).toBe(3);
    expect(firstNonZero(-2, 5)).toBe(-2);
    expect(firstNonZero(0, 0)).toBe(0);
    expect(firstNonZero()).toBe(0);
  });
  it('orders texts and numbers', () => {
    expect(compareValues('a', 'b')).toBe(-1);
    expect(compareValues('b', 'a')).toBe(1);
    expect(compareValues('a', 'a')).toBe(0);
    expect(compareValues(2, 10)).toBe(-1);
  });
});


describe('filledStrings', () => {
  it('keeps trimmed non-empty text and drops the rest', () => {
    expect(filledStrings({ a: ' x ', b: '  ', c: 3, d: null })).toEqual({ a: 'x' });
    expect(filledStrings(null)).toEqual({});
  });
});
