import { describe, expect, it } from 'vitest';
import { emptyToNull, firstFilled, has, nth, orElse, readText, required, trimToNull } from './values';

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
