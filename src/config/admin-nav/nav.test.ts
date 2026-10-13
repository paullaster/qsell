import { describe, expect, it } from 'vitest';
import { getAdminNav, normalizeAdminNav } from './nav.utils';
import type { PermissionKey } from '@/server/domains/access-control/permissions';
import type { AdminNavItem } from './types';

const walk = (
  items: AdminNavItem[],
  path: string[] = [],
): Array<{ item: AdminNavItem; path: string[] }> =>
  items.flatMap((i) => [{ item: i, path }, ...walk(i.subLinks ?? [], [...path, i.id])]);

const nav = getAdminNav();
const all = walk(nav);

describe('the admin sidebar', () => {
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

describe('who sees what in the admin sidebar', () => {
  const ids = (items: AdminNavItem[]): string[] =>
    items.flatMap((i) => [i.id, ...ids(i.subLinks ?? [])]);
  const as = (...permissions: PermissionKey[]) =>
    ids(getAdminNav(null, { superAdmin: false, permissions }));

  it('shows nothing to someone with no permissions', () => {
    expect(as()).toEqual([]);
  });

  it('shows a super admin every enabled item', () => {
    const everything = ids(getAdminNav(null, { superAdmin: true, permissions: [] }));
    expect(everything).toEqual(all.map((x) => x.item.id));
  });

  it('shows only the screens a user may open, and only the sections that hold them', () => {
    expect(as('receipts:read')).toEqual(['finance', 'accounts-receivable', 'ar-receipts']);
  });

  it('accepts any one of several permissions', () => {
    expect(as('products:delete')).toContain('products-trash');
    expect(as('products:delete_permanently')).toContain('products-trash');
  });

  it('hides a section whose own permission is missing, along with everything under it', () => {
    expect(as('pricing:read')).not.toContain('pricing-groups');
  });

  it('never shows a disabled item, nor anything under it', () => {
    const tree: AdminNavItem[] = [
      {
        id: 'a',
        title: 'A',
        name: 'a',
        href: '/admin/a',
        disabled: true,
        subLinks: [{ id: 'b', title: 'B', name: 'b', href: '/admin/b', permission: 'orders:read' }],
      },
    ];
    expect(normalizeAdminNav(tree)).toEqual([]);
  });

  it('is not disabled unless the config says so, and every screen names its permission', () => {
    expect(all.every((x) => x.item.disabled === false)).toBe(true);
    expect(all.filter((x) => !x.item.subLinks?.length && !x.item.permission)).toEqual([]);
  });
});
