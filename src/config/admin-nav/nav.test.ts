import { describe, expect, it } from 'vitest';
import { getAdminNav, normalizeAdminNav } from './nav.utils';
import type { PermissionKey } from '@/server/domains/access-control/permissions';
import type { AdminNavItem } from './types';

const walk = (
  items: AdminNavItem[],
  path: string[] = [],
): { item: AdminNavItem; path: string[] }[] =>
  items.flatMap((i) => [{ item: i, path }, ...walk(i.subLinks ?? [], [...path, i.id])]);

const nav = getAdminNav();
const all = walk(nav);

describe('the admin sidebar', () => {
  const where = (id: string) => all.find((x) => x.item.id === id)?.path.join('/');

  it('has no module called Pricing: pricing is a part of Sales', () => {
    expect(nav.map((m) => m.id)).not.toContain('pricing');
    expect(where('pricing')).toBe('sales');
  });

  it('labels the web shop order screen under Sales', () => {
    const item = all.find((x) => x.item.id === 'orders');
    expect(item?.path).toEqual(['sales']);
    expect(item?.item.title).toBe('Web Shop Orders');
    expect(item?.item.href).toBe('/admin/orders');
  });

  it('puts customer credit, cash sales, selling documents, registers, partial billing, offline selling and van sales under Settings > Sales', () => {
    const parent = all.find((x) => x.item.id === 'settings-sales')?.item;
    expect(where('settings-sales')).toBe('settings');
    expect(parent?.href).toBe('/admin/settings/sales');
    expect(parent?.subLinks?.map((x) => x.id)).toEqual([
      'settings-sales-customer',
      'settings-sales-cash-sales',
      'settings-selling-documents',
      'settings-registers',
      'settings-partial-billing',
      'settings-offline-selling',
      'settings-van-sales',
    ]);
    for (const [id, name] of [
      ['settings-registers', 'registers'],
      ['settings-partial-billing', 'partial-billing'],
      ['settings-offline-selling', 'offline-selling'],
      ['settings-van-sales', 'van-sales'],
    ] as const) {
      expect(where(id)).toBe('settings/settings-sales');
      expect(all.find((x) => x.item.id === id)?.item.href).toBe(`/admin/settings/sales/${name}`);
    }
    expect(where('settings-selling-documents')).toBe('settings/settings-sales');
  });

  it('opens Customers on a hub with List and Customer groups', () => {
    const parent = all.find((x) => x.item.id === 'customers')?.item;
    expect(parent?.href).toBe('/admin/customers');
    expect(parent?.subLinks?.map((x) => x.id)).toEqual(['customers-list', 'pricing-groups']);
    const list = all.find((x) => x.item.id === 'customers-list')?.item;
    expect(where('customers-list')).toBe('sales/customers');
    expect(list?.title).toBe('List');
    expect(list?.href).toBe('/admin/customers/list');
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
      'pricing-floors',
      'pricing-limits',
      'pricing-check',
      'pricing-rules',
    ])
      expect(where(id)).toBe('sales/pricing');
    expect(own).toContain('pricing-groups');
  });

  it('keeps every report in the Reports module, under the module it belongs to, and nowhere else', () => {
    expect(where('report-trial-balance')).toBe('reports/reports-module-finance');
    expect(where('report-pricing-insights')).toBe('reports/reports-module-sales');
    expect(where('report-vendor-scorecards')).toBe('reports/reports-module-vendors');
    expect(where('report-late-deliveries')).toBe('reports/reports-module-delivery');
    expect(where('report-customer-analytics')).toBe('reports/reports-module-customers');
    // The screens they were on before are gone from their old modules.
    const old = [
      '/admin/finance/trial-balance',
      '/admin/finance/receivables/ageing',
      '/admin/vendors/reports',
      '/admin/vendors/scorecards',
      '/admin/delivery/reports',
      '/admin/delivery/performance',
      '/admin/delivery/late',
      '/admin/pricing/insights',
      '/admin/analytics',
    ];
    for (const href of old) expect(all.some((x) => x.item.href === href)).toBe(false);
    // Every report link sits under /admin/reports.
    for (const x of all.filter((y) => y.item.id.startsWith('report-'))) {
      expect(x.item.href.startsWith('/admin/reports/')).toBe(true);
    }
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
    const hrefs = all.filter((x) => (x.item.subLinks ?? []).length === 0).map((x) => x.item.href);
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
    expect(as('customers:read')).toContain('customers-list');
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
    expect(
      all.filter((x) => (x.item.subLinks ?? []).length === 0 && x.item.permission === undefined),
    ).toEqual([]);
  });
});
