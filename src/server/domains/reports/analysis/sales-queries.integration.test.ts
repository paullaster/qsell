import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type * as ClientModule from '@/server/db/drizzle/client';
import type * as SchemaModule from '@/server/db/drizzle/schema';
import type * as QueriesModule from './sales-queries';
import { has } from '@/lib/values';

/**
 * The sales queries against a real database built from the migrations:
 *   TEST_DATABASE_URL=postgres://... pnpm test
 * Every row is attached to a branch made here, so other data in a shared database never changes the expected numbers.
 */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

describe.skipIf(!has(url))('sales queries (database)', () => {
  let db: typeof ClientModule.drizzleDb;
  let schema: typeof SchemaModule;
  let q: typeof QueriesModule;
  let branchId: string;
  const tag = randomUUID().slice(0, 6);

  const day = {
    from: new Date('2026-03-10T00:00:00+03:00'),
    to: new Date('2026-03-11T00:00:00+03:00'),
    fromDate: '2026-03-10',
    toDate: '2026-03-10',
  };
  const at = (hhmm: string, date = '2026-03-10') => new Date(`${date}T${hhmm}:00+03:00`);
  const scope = () => ({ kind: 'branch', branchId, branchName: 'Q Branch' }) as const;

  const order = async (
    over: Partial<typeof SchemaModule.orders.$inferInsert>,
    items: { id: string; name: string; qty: number; total: string; cost: string | null }[],
  ) => {
    const id = `ord_${randomUUID()}`;
    await db.insert(schema.orders).values({
      id,
      orderNumber: `Q-${randomUUID().slice(0, 12)}`,
      branchId,
      customerName: 'Q',
      customerEmail: '',
      customerPhone: '',
      shippingAddress: { street: 's', city: 'c', countyOrState: 'k', country: 'KE' },
      subtotal: '0',
      tax: '0',
      shippingFee: '0',
      totalAmount: '0',
      paymentMethod: 'mpesa_daraja',
      paymentStatus: 'paid',
      status: 'processing',
      createdAt: at('10:00'),
      ...over,
    });
    for (const [i, it] of items.entries()) {
      await db.insert(schema.orderItems).values({
        orderId: id,
        productId: it.id,
        productName: it.name,
        sku: `S${String(i)}`,
        quantity: it.qty,
        unitPrice: String(Number(it.total) / it.qty),
        totalPrice: it.total,
        unitCost: it.cost,
        isGift: false,
      });
    }
  };

  beforeAll(async () => {
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    q = await import('./sales-queries');
    const container = (await import('@/server/di/container')).getContainer();
    const companyId = (await container.companySettings.ensureSeeded()).id;
    await db
      .insert(schema.currencies)
      .values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true })
      .onConflictDoNothing();
    const [b] = await db
      .insert(schema.branches)
      .values({ companyId, code: `Q${tag}`, name: 'Q Branch' })
      .returning();
    branchId = b?.id ?? '';

    const soap = { id: `prod_q_soap_${tag}`, name: 'Soap' };
    const milk = { id: `prod_q_milk_${tag}`, name: 'Milk' };
    // A: returning customer 0711 (also bought on 1 March), soap 3 and milk 2.
    await order(
      { customerPhone: '0711', subtotal: '500', tax: '80', shippingFee: '20', totalAmount: '600' },
      [
        { ...soap, qty: 3, total: '300', cost: '50' },
        { ...milk, qty: 2, total: '200', cost: null },
      ],
    );
    await order(
      {
        customerPhone: '0711',
        createdAt: at('09:00', '2026-03-01'),
        subtotal: '50',
        totalAmount: '50',
      },
      [{ ...soap, qty: 1, total: '50', cost: '25' }],
    );
    // C: a new customer 0722, soap 1.
    await order(
      {
        customerPhone: '0722',
        createdAt: at('14:30'),
        subtotal: '100',
        tax: '16',
        totalAmount: '116',
      },
      [{ ...soap, qty: 1, total: '100', cost: '50' }],
    );
    // D: a walk-in with no phone or email.
    await order({ createdAt: at('14:45'), subtotal: '50', totalAmount: '50' }, [
      { ...milk, qty: 1, total: '50', cost: '20' },
    ]);
    // E: cancelled, never counted.
    await order({ status: 'cancelled', totalAmount: '999', subtotal: '999' }, [
      { ...soap, qty: 9, total: '999', cost: '1' },
    ]);
  });

  it('groups items by product with cost only where it is known', async () => {
    const rows = await q.salesByItemCut(db, 'product', day, scope(), 'KES');
    const soap = rows.find((r) => r.label === 'Soap');
    const milk = rows.find((r) => r.label === 'Milk');
    expect(soap).toMatchObject({ sales: 400, units: 4, orders: 2, cost: 200, knownSales: 400 });
    // Milk: one line without a cost (200) and one with (50, cost 20).
    expect(milk).toMatchObject({ sales: 250, units: 3, orders: 2, cost: 20, knownSales: 50 });
    expect(rows[0]?.label).toBe('Soap');
  });

  it('puts products with no category record in one honest bucket, and no supplier in another', async () => {
    const byCategory = await q.salesByItemCut(db, 'category', day, scope(), 'KES');
    expect(byCategory.map((r) => r.label)).toEqual(['Not in a category']);
    expect(byCategory[0]?.sales).toBe(650);
    const byVendor = await q.salesByItemCut(db, 'vendor', day, scope(), 'KES');
    expect(byVendor.map((r) => r.label)).toEqual(['No supplier on record']);
    expect(byVendor[0]?.sales).toBe(650);
  });

  it('adds whole orders by branch exactly as the overview does, and never counts the cancelled one', async () => {
    const rows = await q.salesByOrderCut(db, 'branch', day, scope(), 'KES', 'Africa/Nairobi');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: 'Q Branch', orders: 3, sales: 766, tax: 96 });
    const totals = await q.orderTotals(db, day, scope(), 'KES');
    expect(totals).toMatchObject({ items: 650, tax: 96, delivery: 20, total: 766, orders: 3 });
  });

  it('names customers, with walk-ins together', async () => {
    const rows = await q.salesByOrderCut(db, 'customer', day, scope(), 'KES', 'Africa/Nairobi');
    expect(rows.map((r) => [r.key, r.sales])).toEqual([
      ['0711', 600],
      ['0722', 116],
      ['walk-in', 50],
    ]);
  });

  it('cuts by local day, weekday and hour in the business time zone', async () => {
    const days = await q.salesByOrderCut(db, 'day', day, scope(), 'KES', 'Africa/Nairobi');
    expect(days.map((r) => r.key)).toEqual(['2026-03-10']);
    // 10 March 2026 is a Tuesday: ISO weekday 2.
    const weekdays = await q.salesByOrderCut(db, 'weekday', day, scope(), 'KES', 'Africa/Nairobi');
    expect(weekdays.map((r) => r.key)).toEqual(['2']);
    const hours = await q.salesByOrderCut(db, 'hour', day, scope(), 'KES', 'Africa/Nairobi');
    expect(hours.map((r) => [r.key, r.orders])).toEqual([
      ['10', 1],
      ['14', 2],
    ]);
  });

  it('tells new customers from returning ones, and sets walk-ins apart', async () => {
    const mix = await q.customerMix(db, day, scope(), 'KES');
    expect(mix).toMatchObject({
      newCustomers: 1,
      returningCustomers: 1,
      newSales: 116,
      returningSales: 600,
      walkInOrders: 1,
      walkInSales: 50,
      repeatBuyers: 0,
    });
  });

  it('reads sales returns without error when there are none', async () => {
    expect(await q.returnsByReason(db, day, scope(), 'KES')).toEqual([]);
    expect(await q.returnsByProduct(db, day, scope(), 'KES')).toEqual([]);
  });
});
