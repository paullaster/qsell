import { describe, expect, it } from 'vitest';
import { getAdminNav } from './nav.utils';
import type { AdminNavItem } from './types';

const walk = (
  items: AdminNavItem[],
  path: string[] = [],
): Array<{ item: AdminNavItem; path: string[] }> =>
  items.flatMap((i) => [{ item: i, path }, ...walk(i.subLinks ?? [], [...path, i.id])]);

describe('the admin sidebar', () => {
  const nav = getAdminNav();
  const all = walk(nav);
  const where = (id: string) => all.find((x) => x.item.id === id)?.path.join('/');

  it('has no module called Pricing: pricing is a part of Sales', () => {
    expect(nav.map((m) => m.id)).not.toContain('pricing');
    expect(where('pricing')).toBe('sales');
  });

  it('keeps every pricing screen together under Sales > Pricing, except the master data they use', () => {
    const own = all.filter((x) => x.item.id.startsWith('pricing-')).map((x) => x.item.id);
    for (const id of [
      'pricing-lists',
      'pricing-discounts',
      'pricing-rebates',
      'pricing-loyalty',
      'pricing-gift-cards',
      'pricing-book',
      'pricing-insights',
      'pricing-floors',
      'pricing-limits',
      'pricing-check',
      'pricing-rules',
    ])
      expect(where(id)).toBe('sales/pricing');
    expect(own).toContain('pricing-groups');
  });

  it('puts customer groups with Customers, and kits and product groups with Products and Inventory', () => {
    expect(where('pricing-groups')).toBe('sales/customers');
    expect(where('pricing-kits')).toBe('products-inventory');
    expect(where('pricing-product-groups')).toBe('products-inventory');
  });

  it('gives every screen its own place: no id appears twice and no two screens share an address', () => {
    const ids = all.map((x) => x.item.id);
    expect(new Set(ids).size).toBe(ids.length);
    // A group may open on its first screen, so only the screens themselves must differ.
    const hrefs = all.filter((x) => !x.item.subLinks?.length).map((x) => x.item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('stays within the depth the sidebar allows', () => {
    expect(Math.max(...all.map((x) => x.path.length + 1))).toBeLessThanOrEqual(5);
  });
});
