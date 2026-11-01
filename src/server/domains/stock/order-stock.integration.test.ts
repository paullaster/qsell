import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { has } from '@/lib/values';
import type * as mod_server_di_container from '@/server/di/container';
import type * as mod_server_db_drizzle_client from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';
import type * as InventoryModule from '@/server/domains/inventory/service';
import type * as OrderStockActions from './order-stock-actions';
import type * as MatrixActions from './matrix-actions';
import type { OrderWriteService as OrderWriteServiceType } from '@/server/domains/orders/write-service';
import { settleFinanceBacklog } from './test-support';

const { requirePermission, canPermission } = vi.hoisted(() => ({ requirePermission: vi.fn(), canPermission: vi.fn() }));
vi.mock('@/server/domains/access-control/guard', async (original) => ({ ...(await original<Record<string, unknown>>()), requirePermission, canPermission }));
vi.mock('@/server/domains/finance/action-runner', () => ({ injectedDelay: () => Promise.resolve() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

/**
 * Where an order's stock is held and moving it to another place, and the stock-by-location matrix, against a real database.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

describe.skipIf(!has(url))('order stock and the stock matrix (database)', () => {
  let db: typeof mod_server_db_drizzle_client.drizzleDb;
  let schema: typeof mod_server_db_drizzle_schema;
  let c: ReturnType<typeof mod_server_di_container.getContainer>;
  let inv: typeof InventoryModule;
  let os: typeof OrderStockActions;
  let mx: typeof MatrixActions;
  let createOrder: (typeof OrderWriteServiceType)['createOrder'];
  let companyId: string;
  let branchId: string;
  let itemTypeId: string;
  let main: string;
  let shop: string;
  const granted = new Set<string>();
  const made: string[] = [];

  const product = async (at: { main?: number; shop?: number } = {}) => {
    const id = `prod_os_${randomUUID()}`;
    made.push(id);
    await db.insert(schema.products).values({ id, sku: `OS-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `OSS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: `Held ${id.slice(-6)}`, slug: `os-${randomUUID()}`, itemTypeId, price: '20', costPrice: '10', stockQuantity: 0 });
    for (const [where, q] of [[main, at.main ?? 0], [shop, at.shop ?? 0]] as const) {
      if (q > 0) await db.transaction((tx) => inv.applyStockDelta(tx, { productId: id, delta: q, locationId: where, changeType: 'purchase_order_receipt', referenceId: `GRN-${randomUUID().slice(0, 6)}`, actor: 'tester', note: 'seed' }));
    }
    return id;
  };
  const place = async (productId: string, quantity: number) => {
    const r = await createOrder({
      branchId,
      orderNumber: `OS-${randomUUID()}`,
      customerName: 'Stock Buyer',
      customerEmail: `os-${randomUUID()}@stock.test`,
      customerPhone: '0700000000',
      shippingAddress: { street: '1 Test Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' },
      items: [{ productId, quantity }],
      currency: 'KES',
      paymentMethod: 'mpesa_daraja',
    });
    expect(r.success, r.error).toBe(true);
    return r.order?.id ?? '';
  };
  const balance = async (productId: string, locationId: string) => {
    const rows = await db.select().from(schema.stockBalances).where(and(eq(schema.stockBalances.productId, productId), eq(schema.stockBalances.locationId, locationId)));
    return { onHand: rows.reduce((a, r) => a + r.onHand, 0), reserved: rows.reduce((a, r) => a + r.reserved, 0) };
  };
  const holds = async (orderId: string) => await db.select().from(schema.stockReservations).where(eq(schema.stockReservations.refId, orderId)).orderBy(schema.stockReservations.createdAt);
  const ok = async <T>(p: Promise<{ ok: true; data: T } | { ok: false; error: string }>): Promise<T> => {
    const r = await p;
    if (!r.ok) throw new Error(r.error);
    return r.data;
  };
  const words = async (p: Promise<{ ok: boolean; error?: string }>) => {
    const r = await p;
    return r.ok ? 'OK' : (r.error ?? '');
  };
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'OK';
    } catch (e) {
      return (e as { code?: string }).code ?? (e as Error).message;
    }
  };
  const move = (orderId: string, productId: string, to: string, reason = 'The shop has it nearer') => c.stockReservations.resource({ companyId, refType: 'order', refId: orderId, productId, toLocationId: to, reason, actor: 'tester' });

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    inv = await import('@/server/domains/inventory/service');
    os = await import('./order-stock-actions');
    mx = await import('./matrix-actions');
    const writer = (await import('@/server/domains/orders/write-service')).OrderWriteService;
    createOrder = (input) => writer.createOrder(input);
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    const { branch } = await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Order Stock Co');
    branchId = ((await c.branches.getDefault(companyId)) ?? branch).id;
    itemTypeId = `it_os_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    main = (await c.stockLocations.ensureDefault(companyId)).id;
    shop = (await c.stockLocations.create(companyId, { code: `OS${randomUUID().slice(0, 6)}`, name: 'Order shop', kind: 'store' })).id;
    await c.stockShadow.setShadow(companyId, false);
    await c.stockSettings.setLedgerMode(companyId, true, { requireCleanShadow: false });
  });
  afterAll(async () => {
    await c.stockSettings.setLedgerMode(companyId, false);
    await settleFinanceBacklog(c.finance);
  }, 120_000);
  beforeEach(() => {
    granted.clear();
    for (const k of ['stock:read', 'orders:update']) granted.add(k);
    requirePermission.mockReset().mockImplementation(async (key: string) => {
      if (!granted.has(key)) {
        const { AccessDeniedError } = await import('@/server/domains/access-control/engine');
        throw new AccessDeniedError(key, { allowed: false, reason: 'no_grant' } as never);
      }
      return 'user-a';
    });
    canPermission.mockReset().mockImplementation((key: string) => Promise.resolve(granted.has(key)));
  });

  describe('moving the stock of an order to another place', () => {
    it('gives back the hold at the old place and holds the same at the new one, and says who, why and from where', async () => {
      const p = await product({ main: 10, shop: 10 });
      const id = await place(p, 4);
      expect(await balance(p, main)).toEqual({ onHand: 10, reserved: 4 });
      expect(await move(id, p, shop)).toEqual({ moved: 4 });
      expect(await balance(p, main)).toEqual({ onHand: 10, reserved: 0 });
      expect(await balance(p, shop)).toEqual({ onHand: 10, reserved: 4 });
      const all = await holds(id);
      expect(all.map((h) => [h.locationId, h.state, h.quantity])).toEqual([[main, 'released', 4], [shop, 'held', 4]]);
      expect(all[0]?.reason).toBe('re-sourced: The shop has it nearer');
      expect(all[1]?.sourcing).toMatchObject({ rule: 're_sourced', reason: 'The shop has it nearer' });
      const log = await db.select().from(schema.decisionLog).where(and(eq(schema.decisionLog.subjectId, id), eq(schema.decisionLog.action, 'stock.hold.re_sourced')));
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ actorId: 'tester', fromState: 'MAIN', reasonText: 'The shop has it nearer' });
      expect(log[0]?.toState).not.toBe('MAIN');
      expect((await c.stockShadow.compare({ productIds: [p] })).reservationsDiffer).toBe(0);
    });

    it('still settles: the sale is issued from the new place', async () => {
      const p = await product({ main: 10, shop: 10 });
      const id = await place(p, 3);
      await move(id, p, shop);
      await c.stockReservations.consume({ companyId, refType: 'order', refId: id, actor: 'tester' });
      expect(await balance(p, shop)).toEqual({ onHand: 7, reserved: 0 });
      expect(await balance(p, main)).toEqual({ onHand: 10, reserved: 0 });
    });

    it.each([
      ['without a reason', (o: string, p: string) => move(o, p, shop, '  '), 'REASON_NEEDED'],
      ['to where it already is', (o: string, p: string) => move(o, p, main), 'ALREADY_THERE'],
      ['for a product that has no hold', (o: string) => move(o, 'prod_nothing', shop), 'NO_HOLD'],
      ['to a place that does not exist', (o: string, p: string) => move(o, p, randomUUID()), 'NOT_FOUND'],
    ])('is refused %s', async (_n, run, errorCode) => {
      const p = await product({ main: 5, shop: 5 });
      const id = await place(p, 2);
      expect(await code(run(id, p))).toBe(errorCode);
      expect(await balance(p, main)).toEqual({ onHand: 5, reserved: 2 });
    });

    it('is refused when the new place has not got enough free, saying how much it has, and nothing moves', async () => {
      const p = await product({ main: 10, shop: 3 });
      const id = await place(p, 5);
      const problem = await move(id, p, shop).catch((e: unknown) => e as Error);
      expect(problem).toMatchObject({ code: 'INSUFFICIENT' });
      expect((problem as Error).message).toContain('3 free');
      expect(await balance(p, main)).toEqual({ onHand: 10, reserved: 5 });
      expect(await balance(p, shop)).toEqual({ onHand: 3, reserved: 0 });
      expect((await holds(id)).map((h) => h.state)).toEqual(['held']);
    });

    it('is refused for a place that is stopped or does not sell to the order’s channel', async () => {
      const p = await product({ main: 5 });
      const id = await place(p, 1);
      const closed = await c.stockLocations.create(companyId, { code: `CL${randomUUID().slice(0, 6)}`, name: 'Closed', kind: 'store', sellsChannels: ['sales_order'] });
      expect(await code(move(id, p, closed.id))).toBe('CANNOT_SUPPLY');
      const dead = await c.stockLocations.create(companyId, { code: `DD${randomUUID().slice(0, 6)}`, name: 'Dead', kind: 'store' });
      await c.stockLocations.deactivate(companyId, dead.id);
      expect(await code(move(id, p, dead.id))).toBe('CANNOT_SUPPLY');
    });

    it('cannot be done once the stock has been issued', async () => {
      const p = await product({ main: 5, shop: 5 });
      const id = await place(p, 2);
      await c.stockReservations.consume({ companyId, refType: 'order', refId: id, actor: 'tester' });
      expect(await code(move(id, p, shop))).toBe('NO_HOLD');
    });

    it('happens once when two people do it at the same time', async () => {
      const p = await product({ main: 10, shop: 10 });
      const id = await place(p, 4);
      const results = await Promise.all([code(move(id, p, shop)), code(move(id, p, shop))]);
      // The one that waited finds the hold already moved: either nothing left to move there, or already where it is wanted.
      expect(results.filter((r) => r === 'OK'), results.join(', ')).toHaveLength(1);
      expect(results.filter((r) => r === 'ALREADY_THERE' || r === 'NO_HOLD')).toHaveLength(1);
      expect(await balance(p, shop)).toEqual({ onHand: 10, reserved: 4 });
      expect(await balance(p, main)).toEqual({ onHand: 10, reserved: 0 });
    });

    it('moves a hold that was split over places to one place', async () => {
      const p = await product({ main: 3, shop: 3 });
      const id = await place(p, 5);
      expect((await holds(id)).map((h) => h.state)).toEqual(['held', 'held']);
      const third = await c.stockLocations.create(companyId, { code: `TH${randomUUID().slice(0, 6)}`, name: 'Third', kind: 'warehouse' });
      await db.transaction((tx) => c.stockLedger.post(tx, { companyId, productId: p, locationId: third.id, type: 'receipt', quantity: 9, actor: { type: 'job' } }));
      expect(await move(id, p, third.id)).toEqual({ moved: 5 });
      expect(await balance(p, third.id)).toEqual({ onHand: 9, reserved: 5 });
      expect((await balance(p, main)).reserved + (await balance(p, shop)).reserved).toBe(0);
    });
  });

  describe('the order stock action', () => {
    it('shows each line with its holds, why the place was chosen, and what the person may do', async () => {
      const p = await product({ main: 10, shop: 10 });
      const id = await place(p, 4);
      const view = await ok(os.orderStockAction(id));
      expect(view).toMatchObject({ ledgerOn: true, may: { resource: true } });
      expect(view.lines).toHaveLength(1);
      expect(view.lines[0]).toMatchObject({ productId: p, ordered: 4 });
      expect(view.lines[0]?.holds[0]).toMatchObject({ locationCode: 'MAIN', quantity: 4, state: 'held', why: 'The whole order could come from here' });
      await move(id, p, shop);
      const after = await ok(os.orderStockAction(id));
      expect(after.lines[0]?.holds.map((h) => [h.state, h.locationId])).toEqual([['released', main], ['held', shop]]);
      expect(after.lines[0]?.holds[1]?.why).toContain('Moved here by a person, from MAIN: The shop has it nearer');
    });

    it('asks for stock:read, hides the right to move from those who cannot change orders, and says nothing is held without the ledger', async () => {
      const p = await product({ main: 3 });
      const id = await place(p, 1);
      granted.delete('orders:update');
      expect((await ok(os.orderStockAction(id))).may.resource).toBe(false);
      granted.delete('stock:read');
      expect(await os.orderStockAction(id)).toMatchObject({ ok: false, forbidden: true });
      granted.add('stock:read');
      await c.stockSettings.setLedgerMode(companyId, false);
      try {
        expect((await ok(os.orderStockAction(id))).ledgerOn).toBe(false);
      } finally {
        await c.stockSettings.setLedgerMode(companyId, true, { requireCleanShadow: false });
      }
    });

    it('moves stock through the action only for someone who may change the order, and shows refusals in words', async () => {
      const p = await product({ main: 10, shop: 10 });
      const id = await place(p, 2);
      granted.delete('orders:update');
      expect(await os.resourceOrderStockAction(id, p, shop, 'why')).toMatchObject({ ok: false, forbidden: true });
      expect((await holds(id)).map((h) => h.locationId)).toEqual([main]);
      granted.add('orders:update');
      expect(await words(os.resourceOrderStockAction(id, p, shop, ''))).toContain('Say why');
      expect(await words(os.resourceOrderStockAction(id, p, 'nonsense', 'why'))).toContain('could not be found');
      expect(await words(os.resourceOrderStockAction('', p, shop, 'why'))).toContain('could not be found');
      expect(await ok(os.resourceOrderStockAction(id, p, shop, 'closer to the customer'))).toEqual({ moved: 2 });
    });
  });

  describe('the stock matrix', () => {
    it('lists products with what each place holds and what is promised, and the total over every place', async () => {
      const p = await product({ main: 10, shop: 6 });
      await place(p, 4);
      const view = await ok(mx.stockMatrixAction({ query: (await db.select({ n: schema.products.name }).from(schema.products).where(eq(schema.products.id, p)))[0]?.n }));
      expect(view.rows).toHaveLength(1);
      expect(view.columns[0]).toMatchObject({ code: 'MAIN', isDefault: true });
      expect(view.rows[0]).toMatchObject({ productId: p, total: 16, totalReserved: 4 });
      expect(view.rows[0]?.cells[main]).toEqual({ onHand: 10, reserved: 4 });
      // The shop may not be among the first eight columns of a database with many places, so look at it by itself.
      const shopOnly = await ok(mx.stockMatrixAction({ query: view.rows[0]?.name, locationId: shop }));
      expect(shopOnly.rows[0]?.cells[shop]).toEqual({ onHand: 6, reserved: 0 });
      expect(shopOnly.rows[0]).toMatchObject({ total: 16 });
      expect(view.source).toBe('ledger');
    });

    it('leaves a place out of a row that has nothing there, and filters by place and by having stock', async () => {
      const [has1, none] = [await product({ shop: 5 }), await product({})];
      const names = await db.select({ id: schema.products.id, n: schema.products.name }).from(schema.products).where(inArray(schema.products.id, [has1, none]));
      const nameOf = (id: string) => names.find((x) => x.id === id)?.n ?? '';
      const row = (await ok(mx.stockMatrixAction({ query: nameOf(has1), locationId: shop }))).rows[0];
      expect(Object.keys(row?.cells ?? {})).toEqual([shop]);
      expect((await ok(mx.stockMatrixAction({ query: nameOf(none) }))).rows).toHaveLength(1);
      expect((await ok(mx.stockMatrixAction({ query: nameOf(none), withStock: true }))).rows).toEqual([]);
      const onlyMain = await ok(mx.stockMatrixAction({ query: nameOf(has1), locationId: main }));
      expect(onlyMain.columns.map((c2) => c2.id)).toEqual([main]);
      expect(onlyMain.rows[0]).toMatchObject({ total: 5 });
      expect(Object.keys(onlyMain.rows[0]?.cells ?? {})).toEqual([]);
      expect((await ok(mx.stockMatrixAction({ query: nameOf(has1), locationId: main, withStock: true }))).rows).toEqual([]);
    });

    it('pages by product name without repeats, and shows no more than eight places at once', async () => {
      const tag = `MX${randomUUID().slice(0, 5)}`;
      for (let i = 0; i < 27; i++) {
        const id = `prod_mx_${randomUUID()}`;
        made.push(id);
        await db.insert(schema.products).values({ id, sku: `${tag}-${String(i).padStart(2, '0')}`, stockCode: `${tag}S-${String(i).padStart(2, '0')}`, name: `${tag} item ${String(i).padStart(2, '0')}`, slug: `${tag}-${randomUUID()}`, itemTypeId, price: '1', stockQuantity: 0 });
      }
      for (let i = 0; i < 9; i++) await c.stockLocations.create(companyId, { code: `MC${randomUUID().slice(0, 6)}`, name: `Matrix place ${String(i)}`, kind: 'store' });
      const first = await ok(mx.stockMatrixAction({ query: tag }));
      expect(first.rows).toHaveLength(25);
      expect(first.columns.length).toBeLessThanOrEqual(8);
      expect(first.moreLocations).toBe(true);
      const second = await ok(mx.stockMatrixAction({ query: tag, cursor: first.nextCursor }));
      expect(second.rows).toHaveLength(2);
      const names = [...first.rows, ...second.rows].map((r) => r.name);
      expect(new Set(names).size).toBe(27);
      expect(names).toEqual([...names].sort());
    });

    it('asks for stock:read and says where the figures come from', async () => {
      granted.delete('stock:read');
      expect(await mx.stockMatrixAction({})).toMatchObject({ ok: false, forbidden: true });
      granted.add('stock:read');
      await c.stockSettings.setLedgerMode(companyId, false);
      try {
        expect((await ok(mx.stockMatrixAction({}))).source).toBe('off');
        await c.stockShadow.setShadow(companyId, true);
        expect((await ok(mx.stockMatrixAction({}))).source).toBe('shadow');
        await c.stockShadow.setShadow(companyId, false);
      } finally {
        await c.stockSettings.setLedgerMode(companyId, true, { requireCleanShadow: false });
      }
    });
  });

  afterAll(async () => {
    if (made.length > 0) await db.delete(schema.products).where(inArray(schema.products.id, made));
  });
});
