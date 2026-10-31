import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { has } from '@/lib/values';
import type * as mod_server_di_container from '@/server/di/container';
import type * as mod_server_db_drizzle_client from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';
import type * as InventoryModule from '@/server/domains/inventory/service';
import type * as TransferActions from './transfer-actions';
import type * as LookupSources from './lookup-sources';
import { settleFinanceBacklog } from './test-support';

const { requirePermission, canPermission } = vi.hoisted(() => ({ requirePermission: vi.fn(), canPermission: vi.fn() }));
vi.mock('@/server/domains/access-control/guard', async (original) => ({ ...(await original<Record<string, unknown>>()), requirePermission, canPermission }));
vi.mock('@/server/domains/finance/action-runner', () => ({ injectedDelay: () => Promise.resolve() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

/**
 * The transfer actions against a real database, with the permission check stood in for: who may do what, the list, the detail with its
 * history, and every step through the actions.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

describe.skipIf(!has(url))('stock transfer actions (database)', () => {
  let db: typeof mod_server_db_drizzle_client.drizzleDb;
  let schema: typeof mod_server_db_drizzle_schema;
  let c: ReturnType<typeof mod_server_di_container.getContainer>;
  let inv: typeof InventoryModule;
  let a: typeof TransferActions;
  let sources: typeof LookupSources;
  let companyId: string;
  let itemTypeId: string;
  let main: string;
  let shop: string;
  let asUser = 'user-a';
  const granted = new Set<string>();

  const product = async (stock = 0) => {
    const id = `prod_ta_${randomUUID()}`;
    await db.insert(schema.products).values({ id, sku: `TA-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `TAS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: `Moveable ${id.slice(-6)}`, slug: `ta-${randomUUID()}`, itemTypeId, price: '10', costPrice: '5', stockQuantity: 0 });
    if (stock > 0) await db.transaction((tx) => inv.applyStockDelta(tx, { productId: id, delta: stock, changeType: 'purchase_order_receipt', referenceId: `GRN-${randomUUID().slice(0, 6)}`, actor: 'tester', note: 'seed' }));
    return id;
  };
  const at = async (productId: string, locationId: string) => (await db.select().from(schema.stockBalances).where(and(eq(schema.stockBalances.productId, productId), eq(schema.stockBalances.locationId, locationId)))).reduce((x, r) => x + r.onHand, 0);
  const ok = async <T>(p: Promise<{ ok: true; data: T } | { ok: false; error: string }>): Promise<T> => {
    const r = await p;
    if (!r.ok) throw new Error(r.error);
    return r.data;
  };
  const words = async (p: Promise<{ ok: boolean; error?: string }>) => {
    const r = await p;
    return r.ok ? 'OK' : (r.error ?? '');
  };
  const draft = async (lines: { productId: string; quantity: number }[], from = main, to = shop) => (await ok(a.createStockTransferAction({ fromLocationId: from, toLocationId: to, lines }))).id;
  const detail = async (id: string) => await ok(a.stockTransferAction(id));

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    inv = await import('@/server/domains/inventory/service');
    a = await import('./transfer-actions');
    sources = await import('./lookup-sources');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    itemTypeId = `it_ta_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    main = (await c.stockLocations.ensureDefault(companyId)).id;
    shop = (await c.stockLocations.create(companyId, { code: `TA${randomUUID().slice(0, 6)}`, name: 'Action shop', kind: 'store' })).id;
    await c.stockShadow.setShadow(companyId, false);
    await c.stockSettings.setLedgerMode(companyId, true, { requireCleanShadow: false });
  });
  afterAll(async () => {
    await db.update(schema.stockSettings).set({ transferRequiresApproval: false }).where(eq(schema.stockSettings.companyId, companyId));
    await c.stockSettings.setLedgerMode(companyId, false);
    await settleFinanceBacklog(c.finance);
  }, 120_000);
  beforeEach(() => {
    asUser = 'user-a';
    granted.clear();
    for (const k of ['stock:read', 'stock:transfer_request', 'stock:transfer_approve', 'stock:transfer_ship', 'stock:transfer_receive']) granted.add(k);
    requirePermission.mockReset().mockImplementation(async (key: string) => {
      if (!granted.has(key)) {
        const { AccessDeniedError } = await import('@/server/domains/access-control/engine');
        throw new AccessDeniedError(key, { allowed: false, reason: 'no_grant' } as never);
      }
      return asUser;
    });
    canPermission.mockReset().mockImplementation((key: string) => Promise.resolve(granted.has(key)));
  });

  it('asks for the right permission at every step, and a missing one changes nothing', async () => {
    const p = await product(5);
    const id = await draft([{ productId: p, quantity: 2 }]);
    await a.requestStockTransferAction(id);
    await a.shipStockTransferAction(id, undefined);
    const line = (await detail(id)).lines[0]?.id ?? '';
    await a.receiveStockTransferAction(id, [{ lineId: line, quantity: 2 }]);
    const asked = requirePermission.mock.calls.map((x: unknown[]) => x[0]);
    // Create, ask for, send, (the test looks at the transfer), receive.
    expect(asked).toEqual(['stock:transfer_request', 'stock:transfer_request', 'stock:transfer_ship', 'stock:read', 'stock:transfer_receive']);
    granted.delete('stock:transfer_ship');
    const q = await product(3);
    const second = await draft([{ productId: q, quantity: 1 }]);
    await a.requestStockTransferAction(second);
    expect(await a.shipStockTransferAction(second, undefined)).toMatchObject({ ok: false, forbidden: true });
    expect((await detail(second)).state).toBe('requested');
    expect(await at(q, main)).toBe(3);
  });

  it('a whole transfer through the actions: draft, asked for, sent, received in two parts, with its history', async () => {
    const p = await product(10);
    const id = await draft([{ productId: p, quantity: 10 }]);
    expect(await detail(id)).toMatchObject({ state: 'draft', approvalRequired: false, may: { request: true, approve: true, ship: true, receive: true } });
    await ok(a.requestStockTransferAction(id));
    await ok(a.shipStockTransferAction(id, undefined));
    const sent = await detail(id);
    expect(sent).toMatchObject({ state: 'shipped' });
    expect(sent.lines[0]).toMatchObject({ shippedQuantity: 10, inTransit: 10 });
    const line = sent.lines[0]?.id ?? '';
    expect((await ok(a.receiveStockTransferAction(id, [{ lineId: line, quantity: 4 }]))).state).toBe('partly_received');
    expect((await ok(a.receiveStockTransferAction(id, [{ lineId: line, quantity: 6 }]))).state).toBe('received');
    expect(await at(p, shop)).toBe(10);
    const done = await detail(id);
    expect(done.steps.map((s) => [s.what, s.from, s.to, s.by])).toEqual([
      ['Created', null, 'draft', 'user-a'],
      ['Asked for', 'draft', 'requested', 'user-a'],
      ['Sent', 'requested', 'shipped', 'user-a'],
      ['Received', 'shipped', 'partly_received', 'user-a'],
      ['Received', 'partly_received', 'received', 'user-a'],
    ]);
    expect(done.steps.every((s) => !Number.isNaN(Date.parse(s.at)))).toBe(true);
  });

  it('shows who did a step by name when they are a user of the system', async () => {
    const [u] = await db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).limit(1);
    if (u === undefined) return;
    asUser = u.id;
    const p = await product(2);
    const id = await draft([{ productId: p, quantity: 1 }]);
    expect((await detail(id)).steps[0]?.by).toBe(u.name);
  });

  it('keeps the approval rule: not by the one who asked, and not shipped before', async () => {
    await db.update(schema.stockSettings).set({ transferRequiresApproval: true }).where(eq(schema.stockSettings.companyId, companyId));
    try {
      const p = await product(4);
      const id = await draft([{ productId: p, quantity: 1 }]);
      await ok(a.requestStockTransferAction(id));
      expect((await detail(id)).approvalRequired).toBe(true);
      expect(await words(a.shipStockTransferAction(id, undefined))).toContain('second person to approve');
      expect(await words(a.approveStockTransferAction(id))).toContain('Someone other than');
      asUser = 'user-b';
      await ok(a.approveStockTransferAction(id));
      asUser = 'user-a';
      await ok(a.shipStockTransferAction(id, undefined));
      expect((await detail(id)).state).toBe('shipped');
    } finally {
      await db.update(schema.stockSettings).set({ transferRequiresApproval: false }).where(eq(schema.stockSettings.companyId, companyId));
    }
  });

  it('settles what did not arrive through the actions, and refuses without a reason or a real choice', async () => {
    const p = await product(6);
    const id = await draft([{ productId: p, quantity: 6 }]);
    await ok(a.requestStockTransferAction(id));
    await ok(a.shipStockTransferAction(id, undefined));
    const line = (await detail(id)).lines[0]?.id ?? '';
    expect(await words(a.resolveStockTransferAction(id, [{ lineId: line, quantity: 2, action: 'write_off' }], ' '))).toContain('Say why');
    expect(await words(a.resolveStockTransferAction(id, [{ lineId: line, quantity: 2, action: '' }], 'gone'))).toContain('write it off or send it back');
    await ok(a.resolveStockTransferAction(id, [{ lineId: line, quantity: 2, action: 'write_off' }], 'robbed'));
    await ok(a.receiveStockTransferAction(id, [{ lineId: line, quantity: 4 }]));
    const done = await detail(id);
    expect(done.state).toBe('closed');
    expect(done.lines[0]).toMatchObject({ receivedQuantity: 4, writtenOffQuantity: 2 });
    expect(done.steps.some((s) => s.what === 'Settled what did not arrive' && s.reason === 'robbed')).toBe(true);
  });

  it('refuses what the rules refuse, in words, and treats a made-up id as not found', async () => {
    const p = await product(2);
    expect(await words(a.createStockTransferAction({ fromLocationId: main, toLocationId: main, lines: [{ productId: p, quantity: 1 }] }))).toContain('two different locations');
    expect(await words(a.createStockTransferAction({ fromLocationId: main, toLocationId: shop, lines: [] }))).toContain('at least one product');
    expect(await words(a.createStockTransferAction({ fromLocationId: main, toLocationId: shop, lines: [{ productId: p, quantity: 0 }] }))).toContain('more than zero');
    expect(await words(a.createStockTransferAction('nonsense'))).not.toBe('OK');
    expect(await a.stockTransferAction('1 or 1=1')).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(await a.stockTransferAction(randomUUID())).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    const id = await draft([{ productId: p, quantity: 1 }]);
    expect(await words(a.updateStockTransferAction(id, 'one', { fromLocationId: main, toLocationId: shop, lines: [{ productId: p, quantity: 2 }] }))).toContain('Open the transfer again');
    expect(await words(a.updateStockTransferAction(id, 99, { fromLocationId: main, toLocationId: shop, lines: [{ productId: p, quantity: 2 }] }))).toContain('Someone else changed');
    expect(await words(a.cancelStockTransferAction(id, ''))).toContain('Say why');
    await ok(a.cancelStockTransferAction(id, 'not needed'));
    expect((await detail(id)).cancelReason).toBe('not needed');
  });

  it('lists transfers newest first a page at a time, with a search on the number and a filter by state', async () => {
    const p = await product(50);
    const ids: string[] = [];
    for (let i = 0; i < 27; i++) ids.push(await draft([{ productId: p, quantity: 1 }]));
    await ok(a.requestStockTransferAction(ids[0] ?? ''));
    const first = await ok(a.stockTransfersPageAction({}));
    expect(first.rows).toHaveLength(25);
    expect(first.nextCursor).not.toBeNull();
    expect(first.rows[0]?.id).toBe(ids.at(-1));
    const second = await ok(a.stockTransfersPageAction({ cursor: first.nextCursor }));
    const seen = new Set([...first.rows, ...second.rows].map((r) => r.id));
    expect(seen.size).toBe(first.rows.length + second.rows.length);
    const times = [...first.rows, ...second.rows].map((r) => r.createdAt);
    expect(times).toEqual([...times].sort().reverse());
    const requested = await ok(a.stockTransfersPageAction({ state: 'requested' }));
    expect(requested.rows.map((r) => r.id)).toContain(ids[0]);
    expect(requested.rows.every((r) => r.state === 'requested')).toBe(true);
    const number = (await detail(ids[3] ?? '')).number;
    expect((await ok(a.stockTransfersPageAction({ query: number }))).rows.map((r) => r.id)).toEqual([ids[3]]);
    expect((await ok(a.stockTransfersPageAction({ state: 'nonsense' }))).rows.length).toBeGreaterThan(0);
  });

  it('offers only what the sender holds when choosing products, never how much', async () => {
    const [held, other] = [await product(3), await product(0)];
    const src = sources.STOCK_LOOKUP_SOURCES.find((s) => s.key === 'stock-products');
    const found = await src?.search({ companyId, query: '', limit: 200, after: null, filters: { at: main } });
    const ids = found?.options.map((o) => o.id) ?? [];
    expect(ids).toContain(held);
    expect(ids).not.toContain(other);
    expect(JSON.stringify(found?.options.find((o) => o.id === held))).not.toMatch(/onHand|on_hand|quantity/);
    await expect(src?.search({ companyId, query: '', limit: 10, after: null, filters: { at: 'x' } }) ?? Promise.reject(new Error('missing'))).rejects.toThrow();
  });
});
