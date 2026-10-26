import { describe, expect, it } from 'vitest';
import { mergeWishlists, parseWishlist, WISHLIST_MAX, withProduct } from './wishlist';

describe('wishlist', () => {
  it('adds at the front, once, and removes', () => {
    expect(withProduct(['a', 'b'], 'c', true)).toEqual(['c', 'a', 'b']);
    expect(withProduct(['a', 'b'], 'b', true)).toEqual(['b', 'a']);
    expect(withProduct(['a', 'b'], 'a', false)).toEqual(['b']);
    expect(withProduct(['a'], 'zzz', false)).toEqual(['a']);
  });
  it('is capped', () => {
    const full = Array.from({ length: WISHLIST_MAX }, (_, i) => `p${String(i)}`);
    expect(withProduct(full, 'new', true)).toHaveLength(WISHLIST_MAX);
    expect(withProduct(full, 'new', true)[0]).toBe('new');
  });
  it('reads damage as empty and drops bad ids', () => {
    for (const raw of [null, undefined, '', '{', '{"a":1}', '"x"']) expect(parseWishlist(raw)).toEqual([]);
    expect(parseWishlist('["a",1,"","a","b",null]')).toEqual(['a', 'b']);
  });
  it('merges without repeats', () => {
    expect(mergeWishlists(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
  });
});
