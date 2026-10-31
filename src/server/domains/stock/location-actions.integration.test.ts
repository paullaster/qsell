import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { has } from '@/lib/values';
import type * as mod_server_di_container from '@/server/di/container';
import type * as mod_server_db_drizzle_client from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';
import type * as LocationActions from './location-actions';
import type * as LookupSources from './lookup-sources';
import { settleFinanceBacklog } from './test-support';

const { requirePermission } = vi.hoisted(() => ({ requirePermission: vi.fn() }));
vi.mock('@/server/domains/access-control/guard', async (original) => ({ ...(await original<Record<string, unknown>>()), requirePermission }));
vi.mock('@/server/domains/finance/action-runner', () => ({ injectedDelay: () => Promise.resolve() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

/**
 * The stock location actions and the location picker against a real database, with the permission check stood in for.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

describe.skipIf(!has(url))('stock location actions (database)', () => {
  let db: typeof mod_server_db_drizzle_client.drizzleDb;
  let schema: typeof mod_server_db_drizzle_schema;
  let c: ReturnType<typeof mod_server_di_container.getContainer>;
  let actions: typeof LocationActions;
  let sources: typeof LookupSources;
  let companyId: string;
  let branchId: string;
  let main: string;
  const code = () => `LA${randomUUID().slice(0, 8)}`.toUpperCase();
  const fail = async (p: Promise<{ ok: boolean; error?: string }>) => {
    const r = await p;
    return r.ok ? 'OK' : (r.error ?? '');
  };
  const created = async (over: Record<string, unknown> = {}) => {
    const r = await actions.createStockLocationAction({ code: code(), name: 'Test place', kind: 'warehouse', ...over });
    if (!r.ok) throw new Error(r.error);
    return r.data;
  };
  const page = async (input: Record<string, unknown> = {}) => {
    const r = await actions.stockLocationsPageAction(input);
    if (!r.ok) throw new Error(r.error);
    return r.data;
  };
  const search = (filters: Record<string, string> = {}, query = '', limit = 50) => sources.STOCK_LOOKUP_SOURCES[0]?.search({ companyId, query, limit, after: null, filters }) ?? Promise.reject(new Error('no source'));

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    actions = await import('./location-actions');
    sources = await import('./lookup-sources');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    const { branch } = await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Location Test Co');
    branchId = ((await c.branches.getDefault(companyId)) ?? branch).id;
    main = (await c.stockLocations.ensureDefault(companyId)).id;
  });
  afterAll(async () => {
    await settleFinanceBacklog(c.finance);
  }, 120_000);
  beforeEach(() => {
    requirePermission.mockReset().mockResolvedValue('user-1');
  });

  describe('permissions', () => {
    it('each action asks for one permission: reading for the list, managing for every change', async () => {
      const l = await created();
      await page();
      await actions.updateStockLocationAction(l.id, { code: l.code, name: 'Renamed', kind: 'warehouse' });
      await actions.makeDefaultStockLocationAction(main);
      await actions.setStockLocationActiveAction(l.id, false);
      expect(requirePermission.mock.calls.map((x: unknown[]) => x[0])).toEqual(['stock:locations_manage', 'stock:read', 'stock:locations_manage', 'stock:locations_manage', 'stock:locations_manage']);
    });

    it('turn a refusal into data and change nothing', async () => {
      const l = await created();
      const { AccessDeniedError } = await import('@/server/domains/access-control/engine');
      requirePermission.mockRejectedValue(new AccessDeniedError('stock:locations_manage', { allowed: false, reason: 'no_grant' } as never));
      expect(await actions.updateStockLocationAction(l.id, { code: l.code, name: 'Hacked', kind: 'warehouse' })).toEqual({ ok: false, error: 'You do not have permission to do that.', forbidden: true });
      expect(await actions.stockLocationsPageAction({})).toMatchObject({ ok: false, forbidden: true });
      requirePermission.mockResolvedValue('user-1');
      expect((await c.stockLocations.get(companyId, l.id)).name).toBe('Test place');
    });
  });

  describe('making and changing', () => {
    it('adds a location with the choices made, and shows it in the list', async () => {
      const made = await created({ name: 'Nairobi shop', kind: 'store', branchId, address: '1 Moi Avenue', sellsChannels: ['ecommerce', 'pos_cash_sale'], allowNegative: true });
      const row = (await page({ query: made.code })).rows[0];
      expect(row).toMatchObject({ code: made.code, name: 'Nairobi shop', kind: 'store', branchId, address: '1 Moi Avenue', sellsChannels: ['ecommerce', 'pos_cash_sale'], allowNegative: true, isActive: true, isDefault: false, productsWithStock: 0, stopBlocker: null });
      expect(row?.branchName).not.toBeNull();
    });

    it.each([
      ['no code', { code: '' }, /code is 1 to 20/i],
      ['a code with spaces', { code: 'a b' }, /code is 1 to 20/i],
      ['no name', { name: ' ' }, /name/i],
      ['an unknown kind', { kind: 'shed' }, /kind/i],
      ['a branch that is not there', { branchId: randomUUID() }, /branch could not be found/i],
      ['a quarantine place that sells', { kind: 'quarantine', isSellable: true }, /cannot be sold/i],
      ['an unknown channel', { sellsChannels: ['barter'] }, /sales channels/i],
    ])('refuses %s in words', async (_n, over, words) => {
      expect(await fail(actions.createStockLocationAction({ code: code(), name: 'x', kind: 'warehouse', ...over }))).toMatch(words);
    });

    it('refuses a code already in use, whatever the case, and keeps the first', async () => {
      const first = await created();
      expect(await fail(actions.createStockLocationAction({ code: first.code.toLowerCase(), name: 'Again', kind: 'store' }))).toContain('already exists');
    });

    it('changes a location, and refuses a change to a code another location has', async () => {
      const [a, b] = [await created(), await created()];
      expect((await actions.updateStockLocationAction(a.id, { code: a.code, name: 'New name', kind: 'store', sellsChannels: ['ecommerce'] })).ok).toBe(true);
      expect(await c.stockLocations.get(companyId, a.id)).toMatchObject({ name: 'New name', kind: 'store', sellsChannels: ['ecommerce'] });
      expect(await fail(actions.updateStockLocationAction(b.id, { code: a.code, name: 'x', kind: 'warehouse' }))).toContain('already exists');
    });

    it('treats a malformed or unknown id as not found, not as an error', async () => {
      expect(await fail(actions.updateStockLocationAction('1 or 1=1', { code: 'X', name: 'x', kind: 'store' }))).toMatch(/could not be found/);
      expect(await fail(actions.updateStockLocationAction(randomUUID(), { code: 'X', name: 'x', kind: 'store' }))).toMatch(/could not be found/);
      expect(await fail(actions.makeDefaultStockLocationAction(undefined))).toMatch(/could not be found/);
    });
  });

  describe('the list', () => {
    it('is paged by code without repeats, with the next page when there are more', async () => {
      const prefix = `PG${randomUUID().slice(0, 4)}`.toUpperCase();
      for (let i = 0; i < 27; i++) await created({ code: `${prefix}${String(i).padStart(2, '0')}` });
      const first = await page({ query: prefix });
      expect(first.rows).toHaveLength(25);
      expect(first.nextCursor).not.toBeNull();
      const second = await page({ query: prefix, cursor: first.nextCursor });
      expect(second.rows).toHaveLength(2);
      expect(second.nextCursor).toBeNull();
      const codes = [...first.rows, ...second.rows].map((r) => r.code);
      expect(new Set(codes).size).toBe(27);
      expect(codes).toEqual([...codes].sort());
    });

    it('searches code and name, filters by kind, and hides stopped places unless asked', async () => {
      const tag = `FS${randomUUID().slice(0, 5)}`.toUpperCase();
      const van = await created({ code: `${tag}V`, name: 'Rider van', kind: 'van' });
      const shed = await created({ code: `${tag}S`, name: 'Old shed', kind: 'store' });
      await actions.setStockLocationActiveAction(shed.id, false);
      expect((await page({ query: 'rider van' })).rows.map((r) => r.id)).toContain(van.id);
      expect((await page({ query: tag, kind: 'van' })).rows.map((r) => r.id)).toEqual([van.id]);
      expect((await page({ query: tag })).rows.map((r) => r.id)).toEqual([van.id]);
      expect((await page({ query: tag, status: 'all' })).rows.map((r) => r.id).sort()).toEqual([van.id, shed.id].sort());
      expect((await page({ query: tag, status: 'stopped' })).rows.map((r) => r.id)).toEqual([shed.id]);
    });

    it('never lists the transit places the system makes for transfers', async () => {
      const transit = await c.stockLocations.create(companyId, { code: `TRN${randomUUID().slice(0, 6)}`, name: 'x', kind: 'store' });
      await db.update(schema.stockLocations).set({ kind: 'transit', isSellable: false }).where(eq(schema.stockLocations.id, transit.id));
      expect((await page({ query: transit.code, status: 'all' })).rows).toEqual([]);
    });

    it('says why a place cannot be stopped: it is the default, or it holds or has promised stock', async () => {
      const loc = await created();
      const prod = `prod_la_${randomUUID()}`;
      const it = `it_la_${randomUUID().slice(0, 6)}`;
      await db.insert(schema.itemTypes).values({ id: it, code: Math.floor(Math.random() * 1e9), name: it });
      await db.insert(schema.products).values({ id: prod, sku: `LA-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `LAS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: 'Placed', slug: `la-${randomUUID()}`, itemTypeId: it, price: '1', stockQuantity: 0 });
      await db.transaction((tx) => c.stockLedger.post(tx, { companyId, productId: prod, locationId: loc.id, type: 'receipt', quantity: 4, actor: { type: 'job' } }));
      const row = (await page({ query: loc.code })).rows[0];
      expect(row).toMatchObject({ productsWithStock: 1 });
      expect(row?.stopBlocker).toContain('holds or has promised stock of 1 product');
      expect(await fail(actions.setStockLocationActiveAction(loc.id, false))).toContain('still holds');
      const def = (await page({ query: 'MAIN' })).rows.find((r) => r.id === main);
      expect(def?.stopBlocker).toContain('default location');
      expect(await fail(actions.setStockLocationActiveAction(main, false))).toContain('default');
    });

    it('stops and restarts, and hands the default over', async () => {
      const loc = await created();
      expect((await actions.setStockLocationActiveAction(loc.id, false)).ok).toBe(true);
      expect((await c.stockLocations.get(companyId, loc.id)).isActive).toBe(false);
      expect((await actions.setStockLocationActiveAction(loc.id, true)).ok).toBe(true);
      expect(await fail(actions.setStockLocationActiveAction(loc.id, 'yes'))).toContain('stop or restart');
      expect((await actions.makeDefaultStockLocationAction(loc.id)).ok).toBe(true);
      expect((await c.stockLocations.get(companyId, loc.id)).isDefault).toBe(true);
      expect((await actions.makeDefaultStockLocationAction(main)).ok).toBe(true);
      expect((await c.stockLocations.get(companyId, main)).isDefault).toBe(true);
    });
  });

  describe('the location picker', () => {
    it('lists active places for choosing, never the transit ones or the stopped ones, and never stock figures', async () => {
      const tag = `PK${randomUUID().slice(0, 5)}`.toUpperCase();
      const live = await created({ code: `${tag}A`, name: 'Picker live' });
      const stopped = await created({ code: `${tag}B`, name: 'Picker stopped' });
      await actions.setStockLocationActiveAction(stopped.id, false);
      const transit = await c.stockLocations.create(companyId, { code: `${tag}C`, name: 'Picker transit', kind: 'store' });
      await db.update(schema.stockLocations).set({ kind: 'transit', isSellable: false }).where(eq(schema.stockLocations.id, transit.id));
      const found = await search({}, tag);
      expect(found.options.map((o) => o.id)).toEqual([live.id]);
      expect(found.options[0]).toMatchObject({ label: `${tag}A · Picker live`, badge: null });
      expect(JSON.stringify(found.options[0])).not.toMatch(/onHand|on_hand|quantity/);
    });

    it('can leave one place out and ask for places that sell to a channel, and refuses any other filter', async () => {
      const tag = `PF${randomUUID().slice(0, 5)}`.toUpperCase();
      const a = await created({ code: `${tag}A`, sellsChannels: ['ecommerce'] });
      const b = await created({ code: `${tag}B`, sellsChannels: ['sales_order'] });
      expect((await search({ exclude: a.id }, tag)).options.map((o) => o.id)).toEqual([b.id]);
      expect((await search({ channel: 'ecommerce' }, tag)).options.map((o) => o.id)).toEqual([a.id]);
      await expect(search({ exclude: 'nope' })).rejects.toThrow();
      await expect(search({ channel: 'barter' })).rejects.toThrow();
      await expect(search({ colour: 'red' })).rejects.toThrow();
    });

    it('marks the default place', async () => {
      expect((await search({}, 'MAIN')).options.find((o) => o.id === main)?.badge).toBe('Default');
    });
  });
});
