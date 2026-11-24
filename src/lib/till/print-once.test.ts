import { describe, expect, it, vi } from 'vitest';
import { printOnce } from './print-once';

describe('printOnce', () => {
  it('prints a thing once however many times it is asked', () => {
    const once = printOnce();
    const print = vi.fn();
    const sale = { orderNumber: 'A' };
    expect(once(sale, print)).toBe(true);
    expect(once(sale, print)).toBe(false);
    expect(once(sale, print)).toBe(false);
    expect(print).toHaveBeenCalledTimes(1);
  });

  it('prints a new request for the same sale again (a reprint)', () => {
    const once = printOnce();
    const print = vi.fn();
    once({ orderNumber: 'A' }, print);
    once({ orderNumber: 'A' }, print);
    expect(print).toHaveBeenCalledTimes(2);
  });
});
