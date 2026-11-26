import { beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { getContainer } from '@/server/di/container';
import type { drizzleDb } from '@/server/db/drizzle/client';
import type * as schemaModule from '@/server/db/drizzle/schema';
import type { SalesQuoteService } from './service';
import { parseCount } from '@/server/domains/selling/shifts/shift-rules';

/**
 * A quote becomes a sales order, a sales invoice, a credit sale or a cash sale, each as the company's settings for that kind say, at the
 * quote's own prices, once only (database).
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (url !== undefined && url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === undefined || url === '')('quote conversion (database)', () => {
  let c: ReturnType<typeof getContainer>;
  let db: typeof drizzleDb;
  let schema: typeof schemaModule;
  let quotes: SalesQuoteService;
  let companyId: string;
  let branchId: string;
  let itemTypeId: string;
  const actor = { type: 'user' as const, id: 'quote-conversion-test' };
  const reason = { code: 'POLICY_CHANGE' };
  const methods: Record<'cash' | 'mobile_money' | 'card', string> = { cash: '', mobile_money: '', card: '' };

  const user = async (name: string) => {
    const [row] = await db.insert(schema.users).values({ email: `${name}-${randomUUID().slice(0, 8)}@cs.test`, passwordHash: 'x', name, role: 'manager' }).returning();
    if (row === undefined) throw new Error('no user');
    return row;
  };
  const counted = (total: number) => {
    const r = parseCount({ total }, 'cash');
    if (!r.ok) throw new Error(r.error);
    return r;
  };
  const shiftFor = async (person: { id: string }, float = 1000) => {
    const name = `CS till ${randomUUID().slice(0, 6)}`;
    await c.shifts.saveRegister(companyId, actor, { branchId, name, isActive: true }, reason);
    const till = (await c.shifts.registerList(companyId)).find((r) => r.name === name);
    const opened = await c.shifts.open(companyId, { userId: person.id, branchId: null }, { registerId: till?.id ?? '', float: counted(float) });
    if (!opened.ok) throw new Error(opened.error);
    return opened.shiftId;
  };
  /** A tea at 100 (tax included, no VAT), 100 in stock. */
  const teaProduct = async (price = 100) => {
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({ id, sku: `CS-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `CSS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: 'Counter tea', slug: `cs-${randomUUID()}`, itemTypeId, price: String(price), costPrice: '10', taxRate: '0', isTaxInclusive: true, stockQuantity: 100 });
    return id;
  };
  const stockOf = async (id: string) => {
    const [row] = await db.select({ stock: schema.products.stockQuantity, reserved: schema.products.reservedQuantity }).from(schema.products).where(eq(schema.products.id, id));
    return { stock: row?.stock ?? 0, reserved: row?.reserved ?? 0 };
  };

  const buyer = async (accountType: 'credit' | 'cash') => {
    const [row] = await db.insert(schema.customers).values({ companyId, number: `QC-${randomUUID().slice(0, 10)}`, name: `Quote ${accountType} ${randomUUID().slice(0, 4)}`, email: `qc-${randomUUID().slice(0, 8)}@qc.test`, phone: '0711000333', accountType, creditLimit: accountType === 'credit' ? '1000000' : '0', paymentTermDays: accountType === 'credit' ? 30 : 0, street: '1 Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'Kenya' }).returning();
    if (row === undefined) throw new Error('no customer');
    return row;
  };
  /** A sent quote for two teas at 100 each (the quote's price), to the buyer; its prices are then changed in the catalogue to show the quote's stand. */
  const sentQuote = async (staffId: string, who: { id: string; name: string; email: string | null }, productId: string, shippingFee = 0) => {
    const made = await quotes.create(staffId, { customerId: who.id, customerName: who.name, customerEmail: who.email, currency: 'KES', paymentMethod: 'mpesa_daraja', discountPercent: 0, shippingFee, sections: [], lines: [{ productId, quantity: 2, unitPrice: 100, discountPercent: 0 }] });
    await db.update(schema.salesQuotes).set({ status: 'sent', deliveryAddress: { street: '1 Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'Kenya' } }).where(eq(schema.salesQuotes.id, made.id));
    return made;
  };
  const orderOf = async (id: string) => (await db.select().from(schema.orders).where(eq(schema.orders.id, id)))[0];
  const eventsOf = async (quoteId: string) => (await db.select().from(schema.salesQuoteEvents).where(eq(schema.salesQuoteEvents.quoteId, quoteId))).map((e) => e.eventType);

  let staffId = '';
  beforeAll(async () => {
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    c = mod.getContainer();
    quotes = new (await import('./service')).SalesQuoteService();
    companyId = (await c.companySettings.ensureSeeded()).id;
    // A chart is applied before any account is added by hand: any account at all stops a template from being applied later, for every file after this one.
    const financeCtx = { companyId, actor, origin: { surface: 'test', action: 'setup' } };
    await c.finance.setup.applyTemplate(financeCtx, 'kenya', { fiscalYearStart: '2026-01-01' }).catch((error: unknown) => {
      if (!(error instanceof Error) || !error.message.includes('already has a chart')) throw error;
    });
    await c.finance.paymentMethods.seedStandard(financeCtx).catch(() => undefined);
    await c.reasonCodes.ensureSystemReasons(companyId);
    itemTypeId = `it_cs_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    const { branch } = await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Cash Sales Co');
    branchId = ((await c.branches.getDefault(companyId)) ?? branch).id;
    // A way of paying for each kind the counter takes, each into its own account.
    const [existing] = await db.select({ id: schema.paymentProviderConfigs.id }).from(schema.paymentProviderConfigs).limit(1);
    const provider = existing ?? (await db.insert(schema.paymentProviderConfigs).values({ companyId, providerCode: 'manual', displayName: 'Manual', isSystem: true, isEnabled: true, apiBaseUrl: 'https://manual.invalid', environment: 'sandbox' } as never).returning({ id: schema.paymentProviderConfigs.id }))[0];
    for (const kind of ['cash', 'mobile_money', 'card'] as const) {
      const run = randomUUID().slice(0, 6).toUpperCase();
      const [bank] = await db.insert(schema.bankAccounts).values({ companyId, code: `CS${kind.slice(0, 1).toUpperCase()}${run}`, name: `Counter ${kind} ${run}`, kind: kind === 'cash' ? 'cash' : 'bank', currency: 'KES', createdBy: 'test' } as never).returning();
      const [gl] = await db.insert(schema.glAccounts).values({ companyId, no: `19${kind.length}${run}`, name: `Counter ${kind} ${run}`, type: 'posting', category: 'assets', normalBalance: 'debit' } as never).returning();
      const [method] = await db.insert(schema.paymentMethods).values({ companyId, providerId: provider?.id ?? '', code: `CS${kind.slice(0, 1).toUpperCase()}${run}`, name: `Counter ${kind} ${run}`, kind, balancingBankAccountId: bank?.id ?? '', glAccountId: gl?.id ?? '', usableFor: ['customer_receipt'], requiresReference: kind !== 'cash', createdBy: 'test' } as never).returning();
      methods[kind] = method?.id ?? '';
    }
    staffId = (await user('quote-staff')).id;
  });

  it('turns a sent quote into a sales invoice with its tax invoice, accepting it for the customer, at the quote\'s price', async () => {
    const tea = await teaProduct(100);
    const who = await buyer('credit');
    const quote = await sentQuote(staffId, who, tea);
    await db.update(schema.products).set({ price: '999' }).where(eq(schema.products.id, tea));
    const done = await quotes.convert(staffId, quote.id, 'sales_invoice');
    expect(done.target).toBe('sales_invoice');
    expect(done.invoiceNumber).toMatch(/^INV-/);
    const order = await orderOf(done.orderId);
    expect(order).toMatchObject({ salesModule: 'sales_invoice', sourceQuoteId: quote.id });
    expect(Number(order?.totalAmount)).toBe(200);
    const after = await quotes.get(quote.id);
    expect(after).toMatchObject({ status: 'converted', convertedOrderId: done.orderId });
    expect(await eventsOf(quote.id)).toEqual(expect.arrayContaining(['accepted', 'converted']));
    // Converting again finds the same document: nothing is made twice.
    const again = await quotes.convert(staffId, quote.id, 'sales_invoice');
    expect(again.orderId).toBe(done.orderId);
  });

  it('turns a quote into a credit sale on the customer\'s account', async () => {
    const tea = await teaProduct(100);
    const who = await buyer('credit');
    const quote = await sentQuote(staffId, who, tea);
    const done = await quotes.convert(staffId, quote.id, 'credit_sale');
    const order = await orderOf(done.orderId);
    expect(order).toMatchObject({ salesModule: 'credit_sale', paymentMethod: 'on_account', sourceQuoteId: quote.id });
    expect(Number(order?.totalAmount)).toBe(200);
  });

  it('refuses a credit sale for a customer with no credit account, and leaves the quote as it was', async () => {
    const tea = await teaProduct(100);
    const who = await buyer('cash');
    const quote = await sentQuote(staffId, who, tea);
    await expect(quotes.convert(staffId, quote.id, 'credit_sale')).rejects.toThrow(/cash customer|not available|credit/i);
    const after = await quotes.get(quote.id);
    expect(after?.convertedOrderId).toBeNull();
    expect(['accepted', 'sent']).toContain(after?.status);
  });

  it('still makes a plain sales order, as before', async () => {
    const tea = await teaProduct(100);
    const who = await buyer('credit');
    const quote = await sentQuote(staffId, who, tea);
    const done = await quotes.convert(staffId, quote.id, 'sales_order');
    expect(done).toMatchObject({ target: 'sales_order' });
    expect((await orderOf(done.orderId))?.sourceQuoteId).toBe(quote.id);
  });

  it('takes a cash sale in the person\'s open shift at the quote\'s price, with change, and a receipt on the POS series', async () => {
    const tea = await teaProduct(100);
    const who = await buyer('cash');
    const cashier = await user('quote-cashier');
    await shiftFor(cashier, 1000);
    const quote = await sentQuote(cashier.id, who, tea);
    await db.update(schema.products).set({ price: '999' }).where(eq(schema.products.id, tea));
    const done = await quotes.convert(cashier.id, quote.id, 'cash_sale', { tenders: [{ methodId: methods.cash, amount: 500, reference: '' }] });
    expect(done.target).toBe('cash_sale');
    expect(done.invoiceNumber).toMatch(/^RCT-/);
    expect(done.receipt).toMatchObject({ total: 200, changeDue: 300 });
    const order = await orderOf(done.orderId);
    expect(order).toMatchObject({ salesModule: 'pos_cash_sale', paymentStatus: 'paid', sourceQuoteId: quote.id });
    expect(await quotes.get(quote.id)).toMatchObject({ status: 'converted', convertedOrderId: done.orderId });
    expect((await stockOf(tea)).stock).toBe(98);
    // Pressing the button again finds the same sale and takes nothing more.
    const again = await quotes.convert(cashier.id, quote.id, 'cash_sale', { tenders: [{ methodId: methods.cash, amount: 500, reference: '' }] });
    expect(again.orderId).toBe(done.orderId);
    expect((await stockOf(tea)).stock).toBe(98);
  });

  it('refuses a cash sale with no open shift, a short payment or a delivery charge, and leaves the quote ready', async () => {
    const tea = await teaProduct(100);
    const who = await buyer('cash');
    const nobody = await user('quote-noshift');
    const quote = await sentQuote(nobody.id, who, tea);
    await expect(quotes.convert(nobody.id, quote.id, 'cash_sale', { tenders: [{ methodId: methods.cash, amount: 500, reference: '' }] })).rejects.toThrow(/shift/i);
    expect((await quotes.get(quote.id))?.convertedOrderId).toBeNull();

    const cashier = await user('quote-short');
    await shiftFor(cashier, 1000);
    await expect(quotes.convert(cashier.id, quote.id, 'cash_sale', { tenders: [{ methodId: methods.cash, amount: 90, reference: '' }] })).rejects.toThrow(/short/i);
    expect((await quotes.get(quote.id))?.status).toBe('accepted');
    expect((await stockOf(tea)).stock).toBe(100);

    const delivered = await sentQuote(cashier.id, who, tea, 150);
    await expect(quotes.convert(cashier.id, delivered.id, 'cash_sale', { tenders: [{ methodId: methods.cash, amount: 500, reference: '' }] })).rejects.toThrow(/delivery charge/i);
    await expect(quotes.convert(cashier.id, quote.id, 'cash_sale', { tenders: [] })).rejects.toThrow(/Choose how/);
  });

  it('will not convert a quote that is only a draft', async () => {
    const tea = await teaProduct(100);
    const who = await buyer('credit');
    const quote = await sentQuote(staffId, who, tea);
    await db.update(schema.salesQuotes).set({ status: 'draft' }).where(and(eq(schema.salesQuotes.id, quote.id)));
    await expect(quotes.convert(staffId, quote.id, 'sales_order')).rejects.toThrow(/accepted/i);
  });

  /** A sent quote with a customer link, as the email carries it. */
  const linked = async (productId: string) => {
    const who = await buyer('credit');
    const quote = await sentQuote(staffId, who, productId);
    const token = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
    await db.update(schema.salesQuotes).set({ shareTokenHash: createHash('sha256').update(token).digest('hex') }).where(eq(schema.salesQuotes.id, quote.id));
    return { quote, token };
  };

  it('keeps the customer\'s link working after they accept: it says accepted, with the day, instead of going missing', async () => {
    const tea = await teaProduct(100);
    const { quote, token } = await linked(tea);
    expect((await quotes.getShared(token))?.state).toBe('open');
    expect(await quotes.respondShared(token, true)).toBe('accepted');
    const after = await quotes.getShared(token);
    expect(after).toMatchObject({ state: 'accepted', quoteNumber: quote.quoteNumber });
    expect(after?.respondedAt).toBeInstanceOf(Date);
    // Accepting by the link makes the sales order itself, and the link still says accepted once the quote has become it.
    expect((await quotes.get(quote.id))?.status).toBe('converted');
    expect((await quotes.getShared(token))?.state).toBe('accepted');
    await expect(quotes.respondShared(token, true)).rejects.toThrow(/no longer active|already/);
  });

  it('says declined, expired and no longer available on the link, and only a stranger\'s address is missing', async () => {
    const tea = await teaProduct(100);
    const declined = await linked(tea);
    await quotes.respondShared(declined.token, false);
    expect(await quotes.getShared(declined.token)).toMatchObject({ state: 'rejected' });

    const late = await linked(tea);
    await db.update(schema.salesQuotes).set({ validUntil: new Date(Date.now() - 86_400_000) }).where(eq(schema.salesQuotes.id, late.quote.id));
    expect(await quotes.getShared(late.token)).toMatchObject({ state: 'expired' });

    const withdrawn = await linked(tea);
    await db.update(schema.salesQuotes).set({ status: 'cancelled' }).where(eq(schema.salesQuotes.id, withdrawn.quote.id));
    expect(await quotes.getShared(withdrawn.token)).toMatchObject({ state: 'closed' });

    expect(await quotes.getShared('f'.repeat(64))).toBeNull();
    expect(await quotes.getShared('not-a-token')).toBeNull();
  });

  const detailsOf = async (quoteId: string, type: string) => (await db.select().from(schema.salesQuoteEvents).where(and(eq(schema.salesQuoteEvents.quoteId, quoteId), eq(schema.salesQuoteEvents.eventType, type))))[0]?.details as Record<string, unknown> | undefined;
  const channelsOf = async (quoteId: string) => ((await detailsOf(quoteId, 'staff_notified'))?.channels ?? []) as { channel: string; status: string; detail: string }[];
  const mode = (onAcceptance: 'notify' | 'sales_order' | 'sales_invoice' | 'credit_sale', over: Record<string, boolean> = {}) =>
    quotes.updateAcceptance(staffId, { onAcceptance, notifyEmail: true, notifySms: false, notifyPush: true, ...over });

  describe('what happens when a customer accepts', () => {
    it('keeps the old behaviour until someone chooses, and checks what is saved', async () => {
      expect(await quotes.getAcceptance()).toEqual({ onAcceptance: 'sales_order', notifyEmail: true, notifySms: false, notifyPush: true });
      await expect(quotes.updateAcceptance(staffId, { onAcceptance: 'cash_sale', notifyEmail: true, notifySms: true, notifyPush: true })).rejects.toThrow(/Choose what happens/);
      await expect(quotes.updateAcceptance(staffId, { onAcceptance: 'notify', notifyEmail: 'yes', notifySms: true, notifyPush: true })).rejects.toThrow(/Choose how staff/);
      expect(await mode('notify', { notifySms: true })).toMatchObject({ onAcceptance: 'notify', notifySms: true });
      expect(await quotes.getAcceptance()).toMatchObject({ onAcceptance: 'notify', notifySms: true });
    });

    it('only marks the quote accepted and tells the staff, when that is the choice: nothing is made, and the customer\'s link says accepted', async () => {
      await mode('notify');
      const tea = await teaProduct(100);
      const { quote, token } = await linked(tea);
      expect(await quotes.respondShared(token, true)).toBe('accepted');
      const after = await quotes.get(quote.id);
      expect(after).toMatchObject({ status: 'accepted', convertedOrderId: null });
      expect((await quotes.getShared(token))?.state).toBe('accepted');
      expect((await db.select().from(schema.orders).where(eq(schema.orders.sourceQuoteId, quote.id)))).toEqual([]);
      const channels = await channelsOf(quote.id);
      expect(channels.map((c) => c.channel)).toEqual(['email', 'sms', 'push']);
      // The staff member who made the quote is written to (Email routing's default for this), and the text and the alert say why they did not go.
      expect(channels[0]).toMatchObject({ channel: 'email', status: 'sent' });
      expect(channels[1]).toMatchObject({ channel: 'sms', status: 'off' });
      expect(['skipped', 'sent']).toContain(channels[2]?.status);
      // A person can then decide which way it goes.
      const done = await quotes.convert(staffId, quote.id, 'sales_invoice');
      expect(done.invoiceNumber).toMatch(/^INV-/);
    });

    it('makes the document the company chose, and says so to the staff', async () => {
      await mode('sales_invoice');
      const tea = await teaProduct(100);
      const { quote, token } = await linked(tea);
      await quotes.respondShared(token, true);
      const after = await quotes.get(quote.id);
      expect(after?.status).toBe('converted');
      const order = await orderOf(after?.convertedOrderId ?? '');
      expect(order).toMatchObject({ salesModule: 'sales_invoice', sourceQuoteId: quote.id });
      expect((await channelsOf(quote.id))[0]).toMatchObject({ channel: 'email', status: 'sent' });
      expect((await detailsOf(quote.id, 'converted'))?.target).toBe('sales_invoice');

      await mode('credit_sale');
      const second = await linked(tea);
      await quotes.respondShared(second.token, true);
      const credit = await quotes.get(second.quote.id);
      expect(await orderOf(credit?.convertedOrderId ?? '')).toMatchObject({ salesModule: 'credit_sale', paymentMethod: 'on_account' });
    });

    it('leaves the quote accepted and tells the staff why when the chosen document cannot be made (a credit sale for a customer with no credit account)', async () => {
      await mode('credit_sale');
      const tea = await teaProduct(100);
      const who = await buyer('cash');
      const quote = await sentQuote(staffId, who, tea);
      const token = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
      await db.update(schema.salesQuotes).set({ shareTokenHash: createHash('sha256').update(token).digest('hex') }).where(eq(schema.salesQuotes.id, quote.id));
      expect(await quotes.respondShared(token, true)).toBe('accepted');
      expect(await quotes.get(quote.id)).toMatchObject({ status: 'accepted', convertedOrderId: null });
      expect((await detailsOf(quote.id, 'order_conversion_failed'))?.target).toBe('credit_sale');
      expect(String((await detailsOf(quote.id, 'order_conversion_failed'))?.error)).not.toBe('');
      expect((await channelsOf(quote.id)).length).toBe(3);
      expect((await quotes.getShared(token))?.state).toBe('accepted');
    });

    it('lets each way of telling staff be switched off, and says why a text or an alert did not go', async () => {
      await mode('notify', { notifyEmail: false, notifySms: true, notifyPush: true });
      const tea = await teaProduct(100);
      const { quote, token } = await linked(tea);
      await quotes.respondShared(token, true);
      const channels = await channelsOf(quote.id);
      expect(channels[0]).toMatchObject({ channel: 'email', status: 'off' });
      expect(channels[1]?.channel).toBe('sms');
      expect(['skipped', 'sent', 'failed']).toContain(channels[1]?.status);
      expect(channels[1]?.status === 'skipped' ? channels[1].detail : 'x').toMatch(/provider|phone number|nobody/i);
      expect(channels[2]?.channel).toBe('push');
      await mode('sales_order');
    });
  });
});
