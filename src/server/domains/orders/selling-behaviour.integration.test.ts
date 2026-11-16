import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { getContainer } from '@/server/di/container';
import type { drizzleDb } from '@/server/db/drizzle/client';
import type * as schemaModule from '@/server/db/drizzle/schema';
import type { OrderWriteService } from './write-service';
import { defOf, type SellingSettings } from '@/server/domains/selling/selling-documents';

/**
 * A staff order follows the company's settings for its kind of sale (credit check, over the limit, credit days, discounts), against
 * a real database. With no settings it behaves as it always has.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (url !== undefined && url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === undefined || url === '')('selling document behaviour in the order writer (database)', () => {
  let c: ReturnType<typeof getContainer>;
  let db: typeof drizzleDb;
  let schema: typeof schemaModule;
  let write: typeof OrderWriteService;
  let companyId: string;
  let branchId: string;
  let productId: string;
  let staffId: string;
  const base = defOf('sales_order').defaults;

  const customer = async (over: Record<string, unknown> = {}) => {
    const email = `buyer-${randomUUID().slice(0, 8)}@selling.test`;
    const [row] = await db.insert(schema.customers).values({ companyId, number: `SB-${randomUUID().slice(0, 10)}`, name: 'Selling Buyer', email, accountType: 'credit', creditLimit: '1000', paymentTermDays: 30, ...over }).returning();
    if (row === undefined) throw new Error('no customer');
    return { id: row.id, email };
  };
  /** A staff sales order for `quantity` of the 100-shilling product (so 1000 is a tenth of the limit of 10 000... see each test). */
  const order = async (email: string, quantity: number, selling?: Partial<SellingSettings>, over: Record<string, unknown> = {}) =>
    await write.createOrder({
      branchId,
      orderNumber: `SB-${randomUUID()}`,
      customerName: 'Selling Buyer',
      customerEmail: email,
      customerPhone: '0700000000',
      shippingAddress: { street: '1 Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' },
      items: [{ productId, quantity }],
      currency: 'KES',
      paymentMethod: 'mpesa_daraja',
      salesModule: 'sales_order',
      requestedBy: staffId,
      ...(selling === undefined ? {} : { selling: { ...base, ...selling } }),
      ...over,
    });
  const dueOf = async (orderId: string) => {
    const [row] = await db.select({ due: schema.customerLedgerEntries.dueDate }).from(schema.customerLedgerEntries).where(eq(schema.customerLedgerEntries.orderId, orderId));
    return row?.due ?? null;
  };
  const daysFromNow = (d: Date | null) => (d === null ? NaN : Math.round((d.getTime() - Date.now()) / 86_400_000) + 0);

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    write = (await import('./write-service')).OrderWriteService;
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    const itemTypeId = `it_sb_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    const { branch } = await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Selling Behaviour Co');
    branchId = ((await c.branches.getDefault(companyId)) ?? branch).id;
    const [user] = await db.insert(schema.users).values({ email: `staff-${randomUUID().slice(0, 8)}@selling.test`, passwordHash: 'x', name: 'Selling Staff', role: 'manager' }).returning();
    staffId = user?.id ?? '';
    productId = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({ id: productId, sku: `SB-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `SBS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: 'Selling tea', slug: `sb-${randomUUID()}`, itemTypeId, price: '100', costPrice: '10', taxRate: '0', isTaxInclusive: true, stockQuantity: 1000 });
  });

  afterAll(async () => {
    await db.execute(sql`select 1`);
  });

  it('behaves as it always has when no settings are given: over the limit is refused when no workflow covers it', async () => {
    const buyer = await customer();
    const refused = await order(buyer.email, 11);
    expect(refused.success).toBe(false);
    expect(refused.error).toContain('would exceed the credit limit of 1,000');
    expect((await order(buyer.email, 5)).success).toBe(true);
  });

  it('does not look at the limit when the credit check is off', async () => {
    const buyer = await customer();
    expect((await order(buyer.email, 11, { creditCheck: 'off' })).success).toBe(true);
  });

  it('refuses over the limit at once when the kind of sale says refuse, and when approval is never asked for', async () => {
    const buyer = await customer();
    const refused = await order(buyer.email, 11, { overLimit: 'refuse' });
    expect(refused.error).toContain('would exceed the credit limit');
    const noApproval = await order(buyer.email, 11, { approval: 'never' });
    expect(noApproval.error).toContain('would exceed the credit limit');
  });

  it('also stops a customer with an invoice overdue by more than the chosen days, and not under the plain limit check', async () => {
    const buyer = await customer();
    // The ledger is append-only, so an old unpaid invoice is entered as one: due 45 days ago and still open.
    await db.insert(schema.customerLedgerEntries).values({ companyId, customerId: buyer.id, documentType: 'invoice', documentNo: `OLD-${randomUUID().slice(0, 6)}`, description: 'Credit invoice', amount: '100.00', remainingAmount: '100.00', dueDate: new Date(Date.now() - 45 * 86_400_000), postingDate: '2020-01-01', currency: 'KES' });
    const refused = await order(buyer.email, 1, { creditCheck: 'limit_and_overdue', overdueDays: 30 });
    expect(refused.success).toBe(false);
    expect(refused.error).toContain('overdue by more than 30 days');
    expect((await order(buyer.email, 1, { creditCheck: 'limit_and_overdue', overdueDays: 60 })).success).toBe(true);
    expect((await order(buyer.email, 1, { creditCheck: 'limit' })).success).toBe(true);
  });

  it('refuses a customer without a credit account when the kind of sale is only for credit customers', async () => {
    const cash = await customer({ accountType: 'cash', creditLimit: '0', paymentTermDays: 0 });
    const refused = await order(cash.email, 1, { noAccount: 'refuse' });
    expect(refused.success).toBe(false);
    expect(refused.error).toContain('no credit account');
    expect((await order(cash.email, 1, { noAccount: 'allow' })).success).toBe(true);
  });

  it('sets the due date by the credit days rule: the customer\'s terms, a fixed number, or due at once', async () => {
    const buyer = await customer({ paymentTermDays: 21 });
    const days = async (selling: Partial<SellingSettings> | undefined) => {
      const placed = await order(buyer.email, 1, selling);
      if (!placed.success || placed.order === undefined) throw new Error(placed.error ?? 'not placed');
      return daysFromNow(await dueOf(placed.order.id));
    };
    expect(await days(undefined)).toBe(21);
    expect(await days({ creditDays: 'customer' })).toBe(21);
    expect(await days({ creditDays: 'fixed', fixedDays: 14 })).toBe(14);
    expect(await days({ creditDays: 'on_issue' })).toBe(0);
  });

  it('does not take coupons on a kind of sale that has no discounts', async () => {
    const buyer = await customer();
    const refused = await order(buyer.email, 1, { discounts: 'not_allowed' }, { couponCodes: ['SAVE10'] });
    expect(refused.success).toBe(false);
    expect(refused.error).toBe('Coupons are not accepted on this kind of sale.');
    expect((await order(buyer.email, 1, { discounts: 'not_allowed' })).success).toBe(true);
  });

  it('is unchanged for the web shop, whatever the settings are', async () => {
    const buyer = await customer({ accountType: 'cash', creditLimit: '0', paymentTermDays: 0 });
    const shop = await write.createOrder({ branchId, orderNumber: `SB-${randomUUID()}`, customerName: 'Shopper', customerEmail: buyer.email, customerPhone: '0711000000', shippingAddress: { street: '1', city: 'N', countyOrState: 'N', country: 'KE' }, items: [{ productId, quantity: 1 }], currency: 'KES', paymentMethod: 'mpesa_daraja' });
    expect(shop.success).toBe(true);
  });
});
