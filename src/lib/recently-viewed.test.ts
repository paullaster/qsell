import { describe, expect, it } from 'vitest';
import { parseRecentlyViewed, viewed } from './recently-viewed';

describe('recently viewed', () => {
  it('moves a product to the front and keeps it once', () => {
    expect(viewed(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
    expect(viewed([], 'x')).toEqual(['x']);
  });
  it('keeps twelve at most', () => {
    const list = Array.from({ length: 12 }, (_, i) => `p${String(i)}`);
    const next = viewed(list, 'new');
    expect(next).toHaveLength(12);
    expect(next[0]).toBe('new');
    expect(next).not.toContain('p11');
  });
  it('reads a damaged list as empty', () => {
    for (const raw of [null, undefined, '', '{', '{"a":1}', '"x"']) expect(parseRecentlyViewed(raw)).toEqual([]);
    expect(parseRecentlyViewed('["a",1,"","a","b"]')).toEqual(['a', 'b']);
  });
});
