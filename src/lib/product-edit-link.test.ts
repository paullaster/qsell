import { describe, expect, it } from 'vitest';
import { isQuickEdit, productEditHref } from './product-edit-link';

describe('product edit shortcut address', () => {
  it('points at the product edit window and marks it as opened from a line', () => {
    expect(productEditHref('abc')).toBe('/admin/products/abc?quick=1');
  });
  it('encodes the id so it cannot change the path', () => {
    expect(productEditHref('a/../b?x=1')).toBe('/admin/products/a%2F..%2Fb%3Fx%3D1?quick=1');
  });
  it('treats only the exact value as the shortcut', () => {
    expect(isQuickEdit('1')).toBe(true);
    for (const v of [undefined, '', '0', 'true', ['1'], ['1', '1']]) expect(isQuickEdit(v)).toBe(false);
  });
});
