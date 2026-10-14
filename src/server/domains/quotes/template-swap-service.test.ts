import { describe, expect, it } from 'vitest';
import { assertQuoteFormShape } from './template-swap-service';

describe('checking a quote form that came from the browser', () => {
  const line = { productId: 'p1', quantity: 2, discountPercent: 0 };

  it('accepts a well-formed form', () => {
    expect(() =>
      assertQuoteFormShape({ lines: [line], sections: [{ id: 's1', title: 'A' }] }),
    ).not.toThrow();
    expect(() => assertQuoteFormShape({ lines: [] })).not.toThrow();
  });

  it('rejects anything that is not a form', () => {
    for (const raw of [null, undefined, 'x', 5, [], { sections: [] }, { lines: 'x' }]) {
      expect(() => assertQuoteFormShape(raw)).toThrow(/Invalid quote/);
    }
  });

  it('rejects bad items and sections', () => {
    const bad = [
      { lines: [{ ...line, productId: 5 }] },
      { lines: [{ ...line, quantity: '2' }] },
      { lines: [{ ...line, quantity: Number.POSITIVE_INFINITY }] },
      { lines: [{ ...line, discountPercent: null }] },
      { lines: [null] },
      { lines: [line], sections: 'x' },
      { lines: [line], sections: [{ id: 1, title: 'A' }] },
      { lines: [line], sections: [{ id: 's', title: 5 }] },
    ];
    for (const raw of bad) expect(() => assertQuoteFormShape(raw)).toThrow(/Invalid quote/);
  });

  it('caps how big a form may be', () => {
    expect(() => assertQuoteFormShape({ lines: Array.from({ length: 5001 }, () => line) })).toThrow(
      /items/,
    );
    const sections = Array.from({ length: 501 }, (_, i) => ({ id: `s${i}`, title: 'A' }));
    expect(() => assertQuoteFormShape({ lines: [], sections })).toThrow(/sections/);
  });
});
