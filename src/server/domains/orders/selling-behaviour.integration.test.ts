import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { getContainer } from '@/server/di/container';
import type { drizzleDb } from '@/server/db/drizzle/client';
import type * as schemaModule from '@/server/db/drizzle/schema';
import type { OrderWriteService } from './write-service';
import type { InventoryReservationService as ReservationService } from '@/server/domains/inventory/reservation-service';
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
  let InventoryReservationService: typeof ReservationService;
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
    InventoryReservationService = (await import('@/server/domains/inventory/reservation-service')).InventoryReservationService;
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

  describe('when the stock leaves and when the invoice is made', () => {
    const stockOf = async (id: string) => {
      const [row] = await db.select({ stock: schema.products.stockQuantity, reserved: schema.products.reservedQuantity }).from(schema.products).where(eq(schema.products.id, id));
      return { stock: row?.stock ?? 0, reserved: row?.reserved ?? 0 };
    };
    /** A product of its own, so each case reads its own stock. */
    const own = async () => {
      const id = `prod_${randomUUID()}`;
      const [mine] = await db.select().from(schema.products).where(eq(schema.products.id, productId));
      await db.insert(schema.products).values({ ...(mine as typeof schema.products.$inferInsert), id, sku: `SBO-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `SBOS-${randomUUID().slice(0, 8)}`.toUpperCase(), slug: `sbo-${randomUUID()}`, stockQuantity: 100, reservedQuantity: 0 });
      return id;
    };
    const place = async (email: string, product: string, selling: Partial<SellingSettings>, over: Record<string, unknown> = {}) => {
      const placed = await write.createOrder({ branchId, orderNumber: `SB-${randomUUID()}`, customerName: 'Selling Buyer', customerEmail: email, customerPhone: '0700000000', shippingAddress: { street: '1 Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' }, items: [{ productId: product, quantity: 4 }], currency: 'KES', paymentMethod: 'mpesa_daraja', salesModule: 'sales_order', requestedBy: staffId, selling: { ...base, creditCheck: 'off', ...selling }, ...over });
      if (!placed.success || placed.order === undefined) throw new Error(placed.error ?? 'not placed');
      return placed.order;
    };

    it('takes the stock off at once when it is to leave when the document is issued', async () => {
      const product = await own();
      const buyer = await customer();
      const o = await place(buyer.email, product, { stockRelease: 'on_issue' });
      expect(o.stockRelease).toBe('on_issue');
      expect(await stockOf(product)).toEqual({ stock: 96, reserved: 0 });
    });

    it('leaves the stock reserved when it is to leave at delivery or collection, as before', async () => {
      const product = await own();
      const buyer = await customer();
      const o = await place(buyer.email, product, { stockRelease: 'on_delivery' });
      expect(o.stockRelease).toBe('on_delivery');
      expect(await stockOf(product)).toEqual({ stock: 100, reserved: 4 });
      expect(await InventoryReservationService.issueDue()).toBeGreaterThanOrEqual(0);
      expect(await stockOf(product)).toEqual({ stock: 100, reserved: 4 });
    });

    it('holds the stock until the document is paid, then takes it off once, within the sweep', async () => {
      const product = await own();
      const buyer = await customer();
      const o = await place(buyer.email, product, { stockRelease: 'on_payment' });
      expect(await stockOf(product)).toEqual({ stock: 100, reserved: 4 });
      await InventoryReservationService.issueDue(500);
      expect(await stockOf(product)).toEqual({ stock: 100, reserved: 4 });
      // The customer pays: a receipt is posted against the invoice, which makes the order paid.
      const fin = c.finance;
      const ctx = { companyId, actor: { type: 'user' as const, id: 'selling-test' }, origin: { surface: 'test', action: 'run' } };
      await fin.setup.applyTemplate(ctx, 'kenya', { fiscalYearStart: '2026-01-01' }).catch(() => undefined);
      await fin.paymentMethods.seedStandard(ctx).catch(() => undefined);
      const methods = Object.fromEntries((await fin.paymentMethods.list(companyId)).map((m) => [m.method.code, m.method.id]));
      const receipt = await fin.receipts.create(ctx, { customerId: buyer.id, paymentMethodId: methods.CASH ?? '', amount: String(o.totalAmount), paymentDate: '2026-10-10' });
      await fin.receipts.post(ctx, receipt.id, { allocate: 'oldest_first' });
      const [paid] = await db.select({ pay: schema.orders.paymentStatus }).from(schema.orders).where(eq(schema.orders.id, o.id));
      expect(paid?.pay).toBe('paid');
      await InventoryReservationService.issueDue(500);
      expect(await stockOf(product)).toEqual({ stock: 96, reserved: 0 });
      // Running the sweep again issues nothing more.
      await InventoryReservationService.issueDue(500);
      expect(await stockOf(product)).toEqual({ stock: 96, reserved: 0 });
    });

    it('lets staff hold one document until it is paid where the kind allows it, and refuses where it does not', async () => {
      const product = await own();
      const buyer = await customer();
      const held = await place(buyer.email, product, { stockRelease: 'on_issue', allowHoldUntilPaid: true }, { holdUntilPaid: true });
      expect(held.stockRelease).toBe('on_payment');
      expect(await stockOf(product)).toEqual({ stock: 100, reserved: 4 });
      const refused = await write.createOrder({ branchId, orderNumber: `SB-${randomUUID()}`, customerName: 'B', customerEmail: buyer.email, customerPhone: '0700000000', shippingAddress: { street: '1', city: 'N', countyOrState: 'N', country: 'KE' }, items: [{ productId: product, quantity: 1 }], currency: 'KES', paymentMethod: 'mpesa_daraja', salesModule: 'sales_order', requestedBy: staffId, selling: { ...base, creditCheck: 'off', allowHoldUntilPaid: false }, holdUntilPaid: true });
      expect(refused.success).toBe(false);
      expect(refused.error).toBe('This kind of sale cannot be held until it is paid.');
      expect(await stockOf(product)).toEqual({ stock: 100, reserved: 4 });
    });

    it('holds the stock for a customer without a credit account when the kind requires payment first, and not for one with an account', async () => {
      const product = await own();
      const cash = await customer({ accountType: 'cash', creditLimit: '0', paymentTermDays: 0 });
      const account = await customer();
      const first = await place(cash.email, product, { stockRelease: 'on_issue', noAccount: 'pay_first' });
      expect(first.stockRelease).toBe('on_payment');
      const second = await place(account.email, product, { stockRelease: 'on_issue', noAccount: 'pay_first' });
      expect(second.stockRelease).toBe('on_issue');
      expect(await stockOf(product)).toEqual({ stock: 96, reserved: 4 });
    });

    it('makes the tax invoice with the document when the kind says so, and leaves it for staff when it does not; the shop and unsettings orders keep no stock release of their own', async () => {
      const product = await own();
      const buyer = await customer();
      const withInvoice = await place(buyer.email, product, { invoice: 'with_document' });
      const later = await place(buyer.email, product, { invoice: 'later' });
      const invoices = async (id: string) => await db.select().from(schema.invoiceDocuments).where(eq(schema.invoiceDocuments.orderId, id));
      expect((await invoices(withInvoice.id)).map((i) => i.documentType)).toEqual(['tax_invoice']);
      expect(await invoices(later.id)).toEqual([]);
      const plain = await order(buyer.email, 1);
      expect(plain.order?.stockRelease ?? null).toBeNull();
    });
  });
});
