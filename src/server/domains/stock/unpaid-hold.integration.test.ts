import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { has, nth } from '@/lib/values';
import type * as mod_server_di_container from '@/server/di/container';
import type * as mod_server_db_drizzle_client from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';

/** An unpaid shop order gives its stock back after the hold time, without the per-location ledger too.   TEST_DATABASE_URL=postgres://... pnpm test */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

describe.skipIf(!has(url))('unpaid orders do not hold stock for ever (database)', () => {
  let c: ReturnType<typeof mod_server_di_container.getContainer>;
  let db: typeof mod_server_db_drizzle_client.drizzleDb;
  let schema: typeof mod_server_db_drizzle_schema;
  let companyId: string;
  let branchId: string;
  let productId: string;
  const helpers = { logger: { info: () => undefined, error: () => undefined } } as never;

  const place = async (method: string) => {
    const { OrderWriteService } = await import('@/server/domains/orders/write-service');
    const r = await OrderWriteService.createOrder({ branchId, orderNumber: `UH-${randomUUID()}`, customerName: 'A', customerEmail: `a-${randomUUID()}@x.test`, customerPhone: '0711000001', shippingAddress: { street: 'x', city: 'y', countyOrState: 'z', country: 'KE' }, items: [{ productId, quantity: 2 }], currency: 'KES', paymentMethod: method as 'mpesa_daraja' });
    return nth([r.order], 0)?.id ?? '';
  };
  const old = (id: string) => db.update(schema.orders).set({ createdAt: new Date(Date.now() - 3 * 3600_000) }).where(eq(schema.orders.id, id));
  const product = async () => nth(await db.select().from(schema.products).where(eq(schema.products.id, productId)), 0);
  const status = async (id: string) => nth(await db.select({ s: schema.orders.status }).from(schema.orders).where(eq(schema.orders.id, id)), 0).s;

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    const { branch } = await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Hold Co');
    branchId = ((await c.branches.getDefault(companyId)) ?? branch).id;
    const itemTypeId = `it_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    productId = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({ id: productId, sku: `H-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `HS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: 'Hold product', slug: `h-${randomUUID()}`, itemTypeId, price: '100', costPrice: '50', stockQuantity: 50, taxRate: '0', isTaxInclusive: true });
  });

  it('after the hold time an unpaid order to be paid at once gives its stock back and is marked failed', async () => {
    await c.stockSettings.setUnpaidHoldMinutes(companyId, 30);
    const id = await place('mpesa_daraja');
    expect((await product()).reservedQuantity).toBe(2);
    await old(id);
    const { stockReservationExpiry } = await import('@/server/queue/tasks');
    await stockReservationExpiry({}, helpers);
    expect((await product()).reservedQuantity).toBe(0);
    expect(await status(id)).toBe('failed');
  });

  it('a recent one is left alone, and so is one when the company chose no time limit', async () => {
    await c.stockSettings.setUnpaidHoldMinutes(companyId, 30);
    const fresh = await place('mpesa_daraja');
    const { stockReservationExpiry } = await import('@/server/queue/tasks');
    await stockReservationExpiry({}, helpers);
    expect(await status(fresh)).toBe('pending');
    await c.stockSettings.setUnpaidHoldMinutes(companyId, 0);
    const kept = await place('mpesa_daraja');
    await old(kept);
    await stockReservationExpiry({}, helpers);
    expect(await status(kept)).toBe('pending');
  });
});
