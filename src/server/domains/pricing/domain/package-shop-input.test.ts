import { describe, expect, it } from 'vitest';
import { parsePackageLine, parsePackageLines, parseServings } from './package-shop-input';

describe('reading a package line from the browser', () => {
  it('keeps ids and counts and nothing else, such as a forged price', () => {
    const line = parsePackageLine({ productId: 'p', servings: 2, price: 1, picks: [{ slotId: 's', optionId: 'o', count: 1, price: 0 }] });
    expect(line).toEqual({ productId: 'p', servings: 2, picks: [{ slotId: 's', optionId: 'o', count: 1 }] });
  });
  it('refuses a line with no product or no servings, and anything that is not an object', () => {
    for (const bad of [null, 'x', 7, [], {}, { productId: 'p' }, { productId: '', servings: 1 }, { productId: 'p', servings: 'two' }]) expect(parsePackageLine(bad)).toBeNull();
  });
  it('drops picks that are not ids and counts', () => {
    const line = parsePackageLine({ productId: 'p', servings: 1, picks: [{ slotId: 's' }, { slotId: 's', optionId: 'o', count: 'x' }, null, { slotId: 's', optionId: 'o', count: 2 }] });
    expect(line?.picks).toEqual([{ slotId: 's', optionId: 'o', count: 2 }]);
  });
  it('bounds the work: ids are short, the basket is at most twenty lines', () => {
    expect(parsePackageLine({ productId: 'x'.repeat(101), servings: 1 })).toBeNull();
    const many = Array.from({ length: 50 }, () => ({ productId: 'p', servings: 1, picks: [] }));
    expect(parsePackageLines(many)).toHaveLength(20);
    expect(parsePackageLines('nope')).toEqual([]);
  });
  it('reads servings as a whole number from one, otherwise one', () => {
    expect([parseServings(3), parseServings(0), parseServings(1.5), parseServings('4'), parseServings(5000)]).toEqual([3, 1, 1, 1, 1]);
  });
});
