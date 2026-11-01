import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { has } from '@/lib/values';
import type * as mod_server_di_container from '@/server/di/container';
import type * as mod_server_db_drizzle_client from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';
import type * as InventoryModule from '@/server/domains/inventory/service';
import type * as CountActions from './count-actions';
import { settleFinanceBacklog } from './test-support';

const { requirePermission, canPermission } = vi.hoisted(() => ({ requirePermission: vi.fn(), canPermission: vi.fn() }));
vi.mock('@/server/domains/access-control/guard', async (original) => ({ ...(await original<Record<string, unknown>>()), requirePermission, canPermission }));
vi.mock('@/server/domains/finance/action-runner', () => ({ injectedDelay: () => Promise.resolve() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

/**
 * The count actions against a real database, with the permission check stood in for.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

describe.skipIf(!has(url))('stock count actions (database)', () => {
  let db: typeof mod_server_db_drizzle_client.drizzleDb;
  let schema: typeof mod_server_db_drizzle_schema;
  let c: ReturnType<typeof mod_server_di_container.getContainer>;
  let inv: typeof InventoryModule;
  let a: typeof CountActions;
  let companyId: string;
  let itemTypeId: string;
  let main: string;
  let asUser = 'user-a';
  const granted = new Set<string>();

  const product = async (stock: number, cost = '10') => {
    const id = `prod_ca_${randomUUID()}`;
    await db.insert(schema.products).values({ id, sku: `CA-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `CAS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: `Counted ${id.slice(-6)}`, slug: `ca-${randomUUID()}`, itemTypeId, price: '20', costPrice: cost, stockQuantity: 0 });
    if (stock > 0) await db.transaction((tx) => inv.applyStockDelta(tx, { productId: id, delta: stock, costPrice: Number(cost), changeType: 'purchase_order_receipt', referenceId: `GRN-${randomUUID().slice(0, 6)}`, actor: 'tester', note: 'seed' }));
    return id;
  };
  const at = async (productId: string) => (await db.select().from(schema.stockBalances).where(and(eq(schema.stockBalances.productId, productId), eq(schema.stockBalances.locationId, main)))).reduce((x, r) => x + r.onHand, 0);
  const ok = async <T>(p: Promise<{ ok: true; data: T } | { ok: false; error: string }>): Promise<T> => {
    const r = await p;
    if (!r.ok) throw new Error(r.error);
    return r.data;
  };
  const words = async (p: Promise<{ ok: boolean; error?: string }>) => {
    const r = await p;
    return r.ok ? 'OK' : (r.error ?? '');
  };
  const open = async (productIds: string[], over: Record<string, unknown> = {}) => (await ok(a.openStockCountAction({ locationId: main, mode: 'cycle', productIds, ...over }))).id;
  const detail = async (id: string) => await ok(a.stockCountAction(id));

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    inv = await import('@/server/domains/inventory/service');
    a = await import('./count-actions');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    itemTypeId = `it_ca_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    main = (await c.stockLocations.ensureDefault(companyId)).id;
    await c.stockShadow.setShadow(companyId, false);
    await c.stockSettings.setLedgerMode(companyId, true, { requireCleanShadow: false });
  });
  afterAll(async () => {
    await db.update(schema.stockSettings).set({ countApprovalValue: '0' }).where(eq(schema.stockSettings.companyId, companyId));
    await c.stockSettings.setLedgerMode(companyId, false);
    await settleFinanceBacklog(c.finance);
  }, 120_000);
  beforeEach(() => {
    asUser = 'user-a';
    granted.clear();
    for (const k of ['stock:read', 'stock:count', 'stock:count_approve']) granted.add(k);
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
    const id = await open([p]);
    await a.recordStockCountAction(id, [{ productId: p, quantity: 4 }]);
    await a.submitStockCountAction(id);
    await a.postStockCountAction(id);
    expect(requirePermission.mock.calls.map((x: unknown[]) => x[0])).toEqual(['stock:count', 'stock:count', 'stock:count', 'stock:count_approve']);
    const q = await product(5);
    const second = await open([q]);
    await a.recordStockCountAction(second, [{ productId: q, quantity: 1 }]);
    await a.submitStockCountAction(second);
    granted.delete('stock:count_approve');
    expect(await a.postStockCountAction(second)).toMatchObject({ ok: false, forbidden: true });
    expect(await a.approveStockCountAction(second)).toMatchObject({ ok: false, forbidden: true });
    expect((await detail(second)).state).toBe('counted');
    expect(await at(q)).toBe(5);
  });

  it('a whole count through the actions, with the differences shown before they are posted', async () => {
    const [x, y] = [await product(10, '10'), await product(10, '20')];
    const id = await open([x, y], { note: 'month end' });
    expect(await detail(id)).toMatchObject({ state: 'counting', mode: 'cycle', blind: false, note: 'month end', may: { count: true, approve: true } });
    await ok(a.recordStockCountAction(id, [{ productId: x, quantity: 8 }, { productId: y, quantity: 10 }]));
    await ok(a.submitStockCountAction(id));
    const review = await detail(id);
    expect(review).toMatchObject({ state: 'counted', varianceValue: 20, needsApproval: false });
    expect(review.lines.map((l) => [l.productId, l.expected, l.counted, l.variance, l.countedByName]).sort()).toEqual([[x, 10, 8, -2, 'user-a'], [y, 10, 10, 0, 'user-a']].sort());
    expect(await ok(a.postStockCountAction(id))).toEqual({ adjusted: 1 });
    expect(await at(x)).toBe(8);
    expect(await at(y)).toBe(10);
    const done = await detail(id);
    expect(done.state).toBe('posted');
    expect(done.steps.map((s) => [s.what, s.to])).toEqual([['Opened', 'counting'], ['Handed in', 'counted'], ['Posted', 'posted']]);
    expect(done.lines.find((l) => l.productId === x)?.variance).toBe(-2);
  });

  it('keeps expected figures from those who only count in a blind count, and shows them to those who approve', async () => {
    const p = await product(10);
    const id = await open([p], { blind: true });
    granted.delete('stock:count_approve');
    expect((await detail(id)).lines[0]).toMatchObject({ expected: null, variance: null });
    granted.add('stock:count_approve');
    expect((await detail(id)).lines[0]).toMatchObject({ expected: 10 });
  });

  it('needs a second person for a large difference: not the one who counted, then posted', async () => {
    await db.update(schema.stockSettings).set({ countApprovalValue: '50' }).where(eq(schema.stockSettings.companyId, companyId));
    try {
      const p = await product(10, '30');
      const id = await open([p]);
      await ok(a.recordStockCountAction(id, [{ productId: p, quantity: 7 }]));
      await ok(a.submitStockCountAction(id));
      expect(await detail(id)).toMatchObject({ varianceValue: 90, needsApproval: true });
      expect(await words(a.postStockCountAction(id))).toContain('more than can be posted without a second person');
      expect(await words(a.approveStockCountAction(id))).toContain('did not take part');
      asUser = 'user-b';
      await ok(a.approveStockCountAction(id));
      expect((await detail(id)).state).toBe('approved');
      await ok(a.postStockCountAction(id));
      expect(await at(p)).toBe(7);
    } finally {
      await db.update(schema.stockSettings).set({ countApprovalValue: '0' }).where(eq(schema.stockSettings.companyId, companyId));
    }
  });

  it('adds a product that was not on the list, can be sent back to correct a figure, and can be cancelled with a reason', async () => {
    const [listed, extra] = [await product(4), await product(6)];
    const id = await open([listed]);
    await ok(a.recordStockCountAction(id, [{ productId: listed, quantity: 4 }, { productId: extra, quantity: 5 }]));
    await ok(a.submitStockCountAction(id));
    expect((await detail(id)).lines.find((l) => l.productId === extra)).toMatchObject({ expected: 6, counted: 5, variance: -1 });
    await ok(a.reopenStockCountAction(id));
    expect((await detail(id)).state).toBe('counting');
    expect(await words(a.cancelStockCountAction(id, ' '))).toContain('Say why');
    await ok(a.cancelStockCountAction(id, 'wrong shelf'));
    expect(await detail(id)).toMatchObject({ state: 'cancelled', cancelReason: 'wrong shelf' });
    expect(await at(extra)).toBe(6);
  });

  it('refuses what the rules refuse, in words, and treats a made-up id as not found', async () => {
    const p = await product(3);
    expect(await words(a.openStockCountAction({ locationId: main, mode: 'weekly', productIds: [p] }))).toContain('full count or a cycle count');
    expect(await words(a.openStockCountAction({ locationId: main, mode: 'cycle', productIds: [] }))).toContain('Choose the products');
    expect(await words(a.openStockCountAction({ locationId: main, mode: 'cycle', productIds: ['prod_nope'] }))).toContain('could not be found');
    expect(await words(a.openStockCountAction({ locationId: randomUUID(), mode: 'cycle', productIds: [p] }))).toContain('could not be found');
    const id = await open([p]);
    expect(await words(a.recordStockCountAction(id, [{ productId: p, quantity: -1 }]))).toContain('zero or more');
    expect(await words(a.recordStockCountAction(id, [{ productId: p, quantity: 1.5 }]))).toContain('whole number');
    expect(await words(a.recordStockCountAction(id, []))).toContain('at least one counted');
    expect(await words(a.submitStockCountAction(id))).toContain('Count at least one product');
    expect(await a.stockCountAction('1 or 1=1')).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(await a.stockCountAction(randomUUID())).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('lists counts newest first a page at a time, with a search on the number, a filter by state, and how far each count has got', async () => {
    const p = await product(50);
    const ids: string[] = [];
    for (let i = 0; i < 27; i++) ids.push(await open([p]));
    await ok(a.recordStockCountAction(ids[1] ?? '', [{ productId: p, quantity: 50 }]));
    await ok(a.submitStockCountAction(ids[1] ?? ''));
    const first = await ok(a.stockCountsPageAction({}));
    expect(first.rows).toHaveLength(25);
    expect(first.ledgerOn).toBe(true);
    expect(first.rows[0]?.id).toBe(ids.at(-1));
    const second = await ok(a.stockCountsPageAction({ cursor: first.nextCursor }));
    expect(new Set([...first.rows, ...second.rows].map((r) => r.id)).size).toBe(first.rows.length + second.rows.length);
    const counted = await ok(a.stockCountsPageAction({ state: 'counted' }));
    expect(counted.rows.find((r) => r.id === ids[1])).toMatchObject({ lines: 1, counted: 1, mode: 'cycle', blind: false });
    const number = (await detail(ids[4] ?? '')).number;
    expect((await ok(a.stockCountsPageAction({ query: number }))).rows.map((r) => r.id)).toEqual([ids[4]]);
  });

  it('shows the list as not yet usable when the ledger is not on, and refuses to open a count', async () => {
    await c.stockSettings.setLedgerMode(companyId, false);
    try {
      expect((await ok(a.stockCountsPageAction({}))).ledgerOn).toBe(false);
      const p = await product(0);
      expect(await words(a.openStockCountAction({ locationId: main, mode: 'cycle', productIds: [p] }))).toContain('not switched on');
    } finally {
      await c.stockSettings.setLedgerMode(companyId, true, { requireCleanShadow: false });
    }
  });
});
