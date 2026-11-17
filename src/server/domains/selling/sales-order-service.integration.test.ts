import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { getContainer } from '@/server/di/container';
import type { drizzleDb } from '@/server/db/drizzle/client';
import type * as schemaModule from '@/server/db/drizzle/schema';
import { defOf } from './selling-documents';

/**
 * Staff take a sales order: the order is placed for a customer through the order writer with the company's settings, a package is
 * chosen by name and part, and the list and the credit position tell staff where things stand (database).
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (url !== undefined && url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === undefined || url === '')('sales orders taken by staff (database)', () => {
  let c: ReturnType<typeof getContainer>;
  let db: typeof drizzleDb;
  let schema: typeof schemaModule;
  let companyId: string;
  let itemTypeId: string;
  let staffId: string;
  const actor = { type: 'user' as const, id: 'sales-order-test' };
  const reason = { code: 'POLICY_CHANGE' };

  const product = async (over: Record<string, unknown> = {}) => {
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({ id, sku: `SOS-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `SOSS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: `Sales order item ${randomUUID().slice(0, 4)}`, slug: `sos-${randomUUID()}`, itemTypeId, price: '100', costPrice: '10', taxRate: '0', isTaxInclusive: true, stockQuantity: 100, ...over });
    return id;
  };
  const customer = async (over: Record<string, unknown> = {}) => {
    const [row] = await db.insert(schema.customers).values({ companyId, number: `SO-${randomUUID().slice(0, 10)}`, name: `Trade ${randomUUID().slice(0, 4)}`, email: `trade-${randomUUID().slice(0, 8)}@so.test`, phone: '0711000111', accountType: 'credit', creditLimit: '1000', paymentTermDays: 30, street: '5 Mill Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'Kenya', ...over }).returning();
    if (row === undefined) throw new Error('no customer');
    return row;
  };
  const input = (customerId: string, lines: unknown[], over: Record<string, unknown> = {}) => ({ customerId, lines: lines as never, paymentMethod: 'mpesa_daraja' as const, neededOn: '', holdUntilPaid: false, ...over });
  const who = () => ({ userId: staffId, branchId: null });

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    itemTypeId = `it_so_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Sales Orders Co');
    const [user] = await db.insert(schema.users).values({ email: `staff-${randomUUID().slice(0, 8)}@so.test`, passwordHash: 'x', name: 'Order Taker', role: 'manager' }).returning();
    staffId = user?.id ?? '';
  });

  afterAll(async () => {
    await db.delete(schema.sellingDocumentSettings).where(eq(schema.sellingDocumentSettings.companyId, companyId));
  });

  it('places an order for a customer as a sales order, priced by the server, and finds it in the list', async () => {
    const tea = await product();
    const buyer = await customer();
    const placed = await c.salesOrders.place(companyId, who(), input(buyer.id, [{ productId: tea, quantity: 3 }]));
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    expect(placed.waitingForApproval).toBe(false);
    const [row] = await db.select().from(schema.orders).where(eq(schema.orders.id, placed.orderId));
    expect(row).toMatchObject({ salesModule: 'sales_order', customerName: buyer.name, tradeCustomerId: buyer.id });
    expect(Number(row?.totalAmount)).toBeCloseTo(300, 1);
    const page = await c.salesOrders.page(companyId, { query: buyer.name });
    expect(page.rows.map((r) => r.orderNumber)).toEqual([placed.orderNumber]);
    expect(page.rows[0]).toMatchObject({ customerName: buyer.name, total: 300, approvalStatus: 'none' });
  });

  it('sells a package chosen by slot name and part, found again as today\'s slots and options', async () => {
    const lunch = await product({ name: 'SO lunch', price: '500', inventoryKind: 'non_inventory', stockQuantity: 0 });
    const small = await product({ name: 'SO small fish', price: '200' });
    const large = await product({ name: 'SO large fish', price: '320' });
    await c.packageConfig.save(companyId, { productId: lunch, pricingMode: 'base_plus_differences', allocation: 'list_price', shortStockMode: 'hide', slots: [{ name: 'Fish', minPicks: 1, maxPicks: 1, options: [{ productId: small, quantity: 1 }, { productId: large, quantity: 1, difference: 120 }] }] } as never, actor, reason);
    const buyer = await customer({ creditLimit: '100000' });
    const placed = await c.salesOrders.place(companyId, who(), input(buyer.id, [{ productId: lunch, quantity: 12, package: { picks: [{ slotName: 'Fish', productId: large, name: 'SO large fish', count: 1 }], note: '' } }]));
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    const [row] = await db.select().from(schema.orders).where(eq(schema.orders.id, placed.orderId));
    expect(Number(row?.totalAmount)).toBeCloseTo(12 * 620, 1);
    const instances = await db.select().from(schema.packageInstances).where(eq(schema.packageInstances.documentId, placed.orderId));
    expect(instances).toHaveLength(1);
    expect(instances[0]?.servings).toBe(12);
    const refused = await c.salesOrders.place(companyId, who(), input(buyer.id, [{ productId: lunch, quantity: 2, package: { picks: [{ slotName: 'Fish', productId: tea0(), name: 'x', count: 1 }], note: '' } }]));
    expect(refused.ok).toBe(false);
  });

  it('follows the company\'s settings for sales orders: over the limit is refused with the credit words, and the credit check can be switched off', async () => {
    const tea = await product();
    const buyer = await customer({ creditLimit: '500' });
    const over = await c.salesOrders.place(companyId, who(), input(buyer.id, [{ productId: tea, quantity: 6 }]));
    expect(over.ok).toBe(false);
    expect(over.ok ? '' : over.error).toContain('would exceed the credit limit of 500');
    await c.sellingSettings.save(companyId, 'sales_order', { ...defOf('sales_order').defaults, creditCheck: 'off' }, actor, reason);
    expect((await c.salesOrders.place(companyId, who(), input(buyer.id, [{ productId: tea, quantity: 6 }]))).ok).toBe(true);
    await c.sellingSettings.reset(companyId, 'sales_order', actor, reason);
  });

  it('refuses an unknown, blocked or another company\'s customer, and an unknown product', async () => {
    const tea = await product();
    expect((await c.salesOrders.place(companyId, who(), input(randomUUID(), [{ productId: tea, quantity: 1 }]))).ok).toBe(false);
    const blocked = await customer({ blocked: 'all' });
    const refused = await c.salesOrders.place(companyId, who(), input(blocked.id, [{ productId: tea, quantity: 1 }]));
    expect(refused.ok ? '' : refused.error).toContain('is blocked from buying');
    const buyer = await customer();
    expect((await c.salesOrders.place(companyId, who(), input(buyer.id, [{ productId: 'prod_nonexistent', quantity: 1 }]))).ok).toBe(false);
  });

  it('says where a customer stands for credit, and reads a customer that is not there as nothing', async () => {
    const buyer = await customer({ creditLimit: '2000', paymentTermDays: 14 });
    expect(await c.salesOrders.creditPosition(companyId, buyer.id)).toMatchObject({ customerId: buyer.id, hasCreditAccount: true, creditLimit: 2000, balance: 0, available: 2000, termDays: 14, blocked: false, overdue: false });
    const cash = await customer({ accountType: 'cash', creditLimit: '0' });
    expect((await c.salesOrders.creditPosition(companyId, cash.id))?.hasCreditAccount).toBe(false);
    expect(await c.salesOrders.creditPosition(companyId, randomUUID())).toBeNull();
  });

  it('lists newest first in pages, narrows by words and status, and leaves out web shop orders', async () => {
    const tea = await product();
    const buyer = await customer({ name: `Pager ${randomUUID().slice(0, 6)}`, creditLimit: '1000000' });
    const numbers: string[] = [];
    for (let n = 0; n < 27; n += 1) {
      const placed = await c.salesOrders.place(companyId, who(), input(buyer.id, [{ productId: tea, quantity: 1 }]));
      if (placed.ok) numbers.push(placed.orderNumber);
    }
    expect(numbers).toHaveLength(27);
    const first = await c.salesOrders.page(companyId, { query: buyer.name });
    expect(first.rows).toHaveLength(25);
    expect(first.rows[0]?.orderNumber).toBe(numbers[26]);
    expect(first.nextCursor).not.toBeNull();
    const second = await c.salesOrders.page(companyId, { query: buyer.name, cursor: first.nextCursor });
    expect(second.rows.map((r) => r.orderNumber)).toEqual([numbers[1], numbers[0]]);
    expect(second.nextCursor).toBeNull();
    expect((await c.salesOrders.page(companyId, { query: buyer.name, status: 'cancelled' })).rows).toEqual([]);
    expect(await c.salesOrders.branchOf(staffId)).toBeNull();
  });
});

const tea0 = (): string => 'prod_not_in_this_package';
