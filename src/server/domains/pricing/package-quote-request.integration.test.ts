import { beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { getContainer } from '@/server/di/container';
import type { drizzleDb } from '@/server/db/drizzle/client';
import type * as schemaModule from '@/server/db/drizzle/schema';
import type { OrderWriteService } from '@/server/domains/orders/write-service';
import type { SalesQuoteService } from '@/server/domains/quotes/service';

/**
 * A package that is ordered by quote request, or by the cart, or either (set per package), against a real database.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (url !== undefined && url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === undefined || url === '')('packages sold by quote request (database)', () => {
  let c: ReturnType<typeof getContainer>;
  let db: typeof drizzleDb;
  let schema: typeof schemaModule;
  let write: typeof OrderWriteService;
  let quotes: SalesQuoteService;
  let companyId: string;
  let itemTypeId: string;
  let branchId: string;
  const actor = { type: 'user' as const, id: 'package-quote-test' };
  const reason = { code: 'POLICY_CHANGE' };

  const product = async (over: Record<string, unknown> = {}) => {
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({
      id,
      sku: `PQ-${randomUUID().slice(0, 8)}`.toUpperCase(),
      stockCode: `PQS-${randomUUID().slice(0, 8)}`.toUpperCase(),
      name: `Quote part ${randomUUID().slice(0, 4)}`,
      slug: `pq-${randomUUID()}`,
      itemTypeId,
      price: '100',
      costPrice: '10',
      taxRate: '0',
      isTaxInclusive: true,
      stockQuantity: 50,
      ...over,
    });
    return id;
  };
  const customer = async () =>
    (await db.insert(schema.customers).values({ companyId, number: `PQC-${randomUUID().slice(0, 10)}`, name: 'Account Holder', email: `holder-${randomUUID()}@pkg.test`, phone: '0711222333', accountType: 'cash' }).returning())[0];

  /** A lunch: a fish slot (large adds 120) and a starch slot, base price 500. */
  const lunch = async (orderMode?: 'cart' | 'quote' | 'either', fishStock = 50) => {
    const p = {
      lunch: await product({ name: 'Quote lunch', price: '500', inventoryKind: 'non_inventory', stockQuantity: 0 }),
      small: await product({ name: 'Quote small fish', price: '200', stockQuantity: fishStock }),
      large: await product({ name: 'Quote large fish', price: '320', stockQuantity: fishStock }),
      ugali: await product({ name: 'Quote ugali', price: '50', stockQuantity: 100 }),
    };
    const view = await c.packageConfig.save(
      companyId,
      {
        productId: p.lunch,
        pricingMode: 'base_plus_differences',
        allocation: 'list_price',
        shortStockMode: 'hide',
        ...(orderMode === undefined ? {} : { orderMode }),
        slots: [
          { name: 'Fish', minPicks: 1, maxPicks: 1, options: [{ productId: p.small, quantity: 1 }, { productId: p.large, quantity: 1, difference: 120 }] },
          { name: 'Starch', minPicks: 1, maxPicks: 1, options: [{ productId: p.ugali, quantity: 1 }] },
        ],
      },
      actor,
      reason,
    );
    const pick = (slot: number, productId: string, count = 1) => {
      const s = view.slots[slot];
      const option = s?.options.find((o) => o.productId === productId);
      if (s === undefined || option === undefined) throw new Error('option missing');
      return { slotId: s.id, optionId: option.id, count };
    };
    const picks = [pick(0, p.large), pick(1, p.ugali)];
    return { p, view, picks };
  };

  const order = (productId: string, servings: number, picks: unknown[]) =>
    write.createOrder({
      branchId,
      orderNumber: `PQO-${randomUUID()}`,
      customerName: 'Cart Buyer',
      customerEmail: `pqo-${randomUUID()}@pkg.test`,
      customerPhone: '0700000000',
      shippingAddress: { street: '1 Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' },
      items: [{ productId, quantity: servings, package: { picks } }] as never,
      currency: 'KES',
      paymentMethod: 'mpesa_daraja',
    });

  const ask = (productId: string, picks: unknown[], over: Record<string, unknown> = {}, customerId: string | null = null) =>
    c.packageQuoteRequests.request(companyId, customerId, {
      line: { productId, picks: picks as never, servings: 12 },
      name: 'Wanjiru Event',
      email: `wanjiru-${randomUUID()}@pkg.test`,
      phone: '',
      neededOn: '',
      message: '',
      ...over,
    });

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    write = (await import('@/server/domains/orders/write-service')).OrderWriteService;
    quotes = new (await import('@/server/domains/quotes/service')).SalesQuoteService();
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    itemTypeId = `it_pq_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    const { branch } = await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Quote Request Co');
    branchId = ((await c.branches.getDefault(companyId)) ?? branch).id;
  });

  describe('the setting', () => {
    it('is the cart for a new package, and is kept when the package is saved again without it', async () => {
      const { p, view } = await lunch();
      expect(view.orderMode).toBe('cart');
      await c.packageConfig.save(companyId, { productId: p.lunch, pricingMode: 'base_plus_differences', allocation: 'list_price', shortStockMode: 'hide', orderMode: 'either', slots: view.slots.map((s) => ({ name: s.name, minPicks: s.minPicks, maxPicks: s.maxPicks, options: s.options.map((o) => ({ productId: o.productId, quantity: o.quantity, difference: o.difference })) })) } as never, actor, reason);
      const again = await c.packageConfig.save(companyId, { productId: p.lunch, pricingMode: 'base_plus_differences', allocation: 'list_price', shortStockMode: 'hide', slots: view.slots.map((s) => ({ name: s.name, minPicks: s.minPicks, maxPicks: s.maxPicks, options: s.options.map((o) => ({ productId: o.productId, quantity: o.quantity, difference: o.difference })) })) } as never, actor, reason);
      expect(again.orderMode).toBe('either');
      expect((await c.packageShop.builder(companyId, p.lunch))?.package.orderMode).toBe('either');
    });

    it('lets the database refuse a mode that does not exist', async () => {
      const { p } = await lunch();
      await expect(db.update(schema.productPackages).set({ orderMode: 'free' as never }).where(eq(schema.productPackages.productId, p.lunch))).rejects.toThrow();
    });
  });

  describe('the cart', () => {
    it('refuses a package sold by quote request only, in words, and takes one that allows the cart', async () => {
      const q = await lunch('quote');
      const refused = await order(q.p.lunch, 2, q.picks);
      expect(refused.success).toBe(false);
      expect(refused.success ? '' : refused.error).toContain('is ordered by quote request');
      for (const mode of ['cart', 'either'] as const) {
        const ok = await lunch(mode);
        expect((await order(ok.p.lunch, 2, ok.picks)).success).toBe(true);
      }
    });

    it('does not start a group order for a package sold by quote request only', async () => {
      const q = await lunch('quote');
      const organiser = await customer();
      const made = await c.packageGroups.create(companyId, { customerId: organiser?.id ?? '', name: 'Organiser' }, { productId: q.p.lunch, title: 'Office lunch', forDate: null, closesAt: null });
      expect(made.ok).toBe(false);
      expect(made.ok ? '' : made.error).toContain('ordered by quote request');
    });

    it('shows every option of a quote-only package even when stock is gone, since a quote promises nothing from the shelves', async () => {
      const q = await lunch('quote', 0);
      const builder = await c.packageShop.builder(companyId, q.p.lunch);
      expect(builder?.offered).toBe(true);
      expect(builder?.available.length).toBe(3);
      const cart = await lunch('cart', 0);
      expect((await c.packageShop.builder(companyId, cart.p.lunch))?.offered).toBe(false);
    });
  });

  describe('asking for a quote', () => {
    it('makes a quote marked as from the shop, priced from the package and not from the browser', async () => {
      const q = await lunch('either');
      const made = await ask(q.p.lunch, q.picks, { neededOn: '2099-05-04', message: 'Office party of 12' });
      expect(made.ok).toBe(true);
      if (!made.ok) return;
      // 12 servings of the base price 500 plus 120 for the large fish.
      expect(made.total).toBeCloseTo(12 * 620, 1);
      const [row] = await db.select().from(schema.salesQuotes).where(eq(schema.salesQuotes.quoteNumber, made.quoteNumber));
      expect(row?.source).toBe('shop');
      expect(row?.status).toMatch(/^(draft|pending_approval)$/);
      expect(row?.customerName).toBe('Wanjiru Event');
      expect(row?.neededOn).toBe('2099-05-04');
      expect(row?.internalNotes).toContain('Office party of 12');
      const lines = await db.select().from(schema.salesQuoteLines).where(eq(schema.salesQuoteLines.quoteId, row?.id ?? ''));
      expect(lines).toHaveLength(1);
      expect(Number(lines[0]?.quantity)).toBe(12);
    });

    it('is refused for a package that is ordered through the cart only', async () => {
      const q = await lunch('cart');
      const made = await ask(q.p.lunch, q.picks);
      expect(made.ok).toBe(false);
      expect(made.ok ? '' : made.error).toContain('ordered through the cart');
    });

    it('quotes a package whose parts are sold out', async () => {
      const q = await lunch('quote', 0);
      expect((await ask(q.p.lunch, q.picks)).ok).toBe(true);
    });

    it('needs a name and a way to answer from a guest, and a day that has not passed', async () => {
      const q = await lunch('quote');
      expect((await ask(q.p.lunch, q.picks, { name: '' })).ok).toBe(false);
      expect((await ask(q.p.lunch, q.picks, { email: '', phone: '' })).ok).toBe(false);
      const old = await ask(q.p.lunch, q.picks, { neededOn: '2001-01-01' });
      expect(old.ok ? '' : old.error).toContain('has not passed');
    });

    it('refuses a choice the package does not offer', async () => {
      const q = await lunch('quote');
      const other = await lunch('quote');
      expect((await ask(q.p.lunch, other.picks)).ok).toBe(false);
      expect((await ask(q.p.lunch, [])).ok).toBe(false);
    });

    it('fills a signed-in shopper\'s details from their account and ties the quote to them', async () => {
      const q = await lunch('quote');
      const holder = await customer();
      const made = await ask(q.p.lunch, q.picks, { name: '', email: '', phone: '' }, holder?.id ?? null);
      expect(made.ok).toBe(true);
      if (!made.ok) return;
      const [row] = await db.select().from(schema.salesQuotes).where(eq(schema.salesQuotes.quoteNumber, made.quoteNumber));
      expect(row?.customerId).toBe(holder?.id);
      expect(row?.customerName).toBe('Account Holder');
      expect(row?.customerPhone).toBe('0711222333');
      expect(await c.packageQuoteRequests.ownContact(companyId, holder?.id ?? '')).toMatchObject({ name: 'Account Holder', phone: '0711222333' });
    });

    it('does not take another company\'s customer id as the signed-in shopper', async () => {
      const q = await lunch('quote');
      const made = await ask(q.p.lunch, q.picks, {}, randomUUID());
      expect(made.ok).toBe(false);
    });

    it('is still from the shop after staff edit it, and becomes an order when accepted even though the package is quote-only', async () => {
      const q = await lunch('quote');
      const made = await ask(q.p.lunch, q.picks);
      if (!made.ok) throw new Error(made.error);
      const [row] = await db.select().from(schema.salesQuotes).where(eq(schema.salesQuotes.quoteNumber, made.quoteNumber));
      const full = await quotes.get(row?.id ?? '');
      if (full === null) throw new Error('quote missing');
      await db.update(schema.salesQuotes).set({ status: 'accepted', deliveryAddress: { street: '1 Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' } }).where(eq(schema.salesQuotes.id, full.id));
      const converted = await quotes.convertToOrder('package-quote-test', full.id);
      expect(converted).not.toBeNull();
      const [after] = await db.select().from(schema.salesQuotes).where(eq(schema.salesQuotes.id, full.id));
      expect(after?.source).toBe('shop');
      expect(after?.status).toBe('converted');
    });
  });

  describe('my quote requests', () => {
    it('lists the shopper\'s own requests with where each stands, and nobody else\'s, and not quotes staff made', async () => {
      const q = await lunch('quote');
      const holder = await customer();
      const stranger = await customer();
      const made = await ask(q.p.lunch, q.picks, { neededOn: '2099-06-01' }, holder?.id ?? null);
      if (!made.ok) throw new Error(made.error);
      await ask(q.p.lunch, q.picks, {}, stranger?.id ?? null);
      // A quote staff made for the same customer is not a request the shopper made.
      const staffMade = await quotes.create(actor.id, { customerId: holder?.id ?? null, customerName: 'Account Holder', customerEmail: 'h@x.test', currency: 'KES', paymentMethod: 'mpesa_daraja', discountPercent: 0, shippingFee: 0, sections: [], lines: [{ productId: q.p.small, quantity: 1, unitPrice: 100, discountPercent: 0 }] });
      const mine = await c.packageQuoteRequests.mine(companyId, holder?.id ?? '');
      expect(mine.map((m) => m.quoteNumber)).toEqual([made.quoteNumber]);
      expect(mine.map((m) => m.quoteNumber)).not.toContain(staffMade.quoteNumber);
      expect(mine[0]).toMatchObject({ state: 'preparing', neededOn: '2099-06-01', orderId: null });
      expect(mine[0]?.lines[0]).toContain('12 ×');
      expect(mine[0]?.total).toBeCloseTo(12 * 620, 1);
      // Once staff send it and the customer accepts, the shopper sees that.
      await db.update(schema.salesQuotes).set({ status: 'sent' }).where(eq(schema.salesQuotes.quoteNumber, made.quoteNumber));
      expect((await c.packageQuoteRequests.mine(companyId, holder?.id ?? ''))[0]?.state).toBe('sent');
      expect(await c.packageQuoteRequests.mine(companyId, randomUUID())).toEqual([]);
    });
  });

  describe('the mails about a request', () => {
    it('writes to the shopper and to the staff, once each, with what was asked for', async () => {
      const { sendQuoteRequestEmail } = await import('@/server/domains/quotes/quote-request-emails');
      await db.update(schema.companySettings).set({ email: `shop-${randomUUID().slice(0, 6)}@company.test` }).where(eq(schema.companySettings.id, companyId));
      const q = await lunch('quote');
      const email = `mails-${randomUUID().slice(0, 6)}@pkg.test`;
      const made = await ask(q.p.lunch, q.picks, { email, message: 'Office party of 12' });
      if (!made.ok) throw new Error(made.error);
      const [row] = await db.select().from(schema.salesQuotes).where(eq(schema.salesQuotes.quoteNumber, made.quoteNumber));
      const send = vi.spyOn(c.email, 'send').mockResolvedValue({ ok: true } as never);
      try {
        expect(await sendQuoteRequestEmail(row?.id ?? '', 'shopper')).toBe('sent');
        expect(await sendQuoteRequestEmail(row?.id ?? '', 'staff')).toBe('sent');
        const [toShopper, toStaff] = send.mock.calls.map((call) => call[0]);
        expect(toShopper?.to).toBe(email);
        expect(toShopper?.subject).toContain(made.quoteNumber);
        expect(toShopper?.text).toContain('Quote lunch');
        expect(toStaff?.to).toContain('@company.test');
        expect(toStaff?.text).toContain('Office party of 12');
        expect(toStaff?.text).toContain('/admin/quotes');
      } finally {
        send.mockRestore();
      }
    });

    it('goes to the people set up in Email routing, with copies and reply addresses, and not at all when switched off', async () => {
      const { sendQuoteRequestEmail } = await import('@/server/domains/quotes/quote-request-emails');
      const person = async (name: string) => {
        const [row] = await db.insert(schema.users).values({ email: `${name}-${randomUUID().slice(0, 6)}@acme.test`, passwordHash: 'x', name, role: 'manager' }).returning();
        if (row === undefined) throw new Error('no user');
        return row;
      };
      const a = await person('alpha');
      const b = await person('bravo');
      await db.update(schema.companySettings).set({ email: 'info@company.test' }).where(eq(schema.companySettings.id, companyId));
      await c.emailRoutes.save(companyId, 'shop_quote_request_staff', { enabled: true, to: [{ kind: 'staff', userId: a.id }, { kind: 'staff', userId: b.id }], cc: [{ kind: 'company' }], bcc: [{ kind: 'address', address: 'audit@acme.test' }], replyTo: [{ kind: 'customer' }] }, actor, reason);
      const q = await lunch('quote');
      const made = await ask(q.p.lunch, q.picks, { email: 'asker@customer.test' });
      if (!made.ok) throw new Error(made.error);
      const [row] = await db.select().from(schema.salesQuotes).where(eq(schema.salesQuotes.quoteNumber, made.quoteNumber));
      const send = vi.spyOn(c.email, 'send').mockResolvedValue({ ok: true } as never);
      try {
        expect(await sendQuoteRequestEmail(row?.id ?? '', 'staff')).toBe('sent');
        expect(send.mock.calls[0]?.[0]).toMatchObject({ to: a.email, toMore: [b.email], cc: ['info@company.test'], bcc: ['audit@acme.test'], replyTo: ['asker@customer.test'] });
        await c.emailRoutes.save(companyId, 'shop_quote_request_customer', { enabled: false }, actor, reason);
        expect(await sendQuoteRequestEmail(row?.id ?? '', 'shopper')).toBe('off');
        expect(send).toHaveBeenCalledTimes(1);
      } finally {
        send.mockRestore();
        await c.emailRoutes.reset(companyId, 'shop_quote_request_staff', actor, reason);
        await c.emailRoutes.reset(companyId, 'shop_quote_request_customer', actor, reason);
      }
    });

    it('says there is nobody to write to when the shopper left only a phone, and writes only about quotes from the shop', async () => {
      const { sendQuoteRequestEmail } = await import('@/server/domains/quotes/quote-request-emails');
      const q = await lunch('quote');
      const made = await ask(q.p.lunch, q.picks, { email: '', phone: '0712345678' });
      if (!made.ok) throw new Error(made.error);
      const [row] = await db.select().from(schema.salesQuotes).where(eq(schema.salesQuotes.quoteNumber, made.quoteNumber));
      expect(await sendQuoteRequestEmail(row?.id ?? '', 'shopper')).toBe('no_address');
      expect(await sendQuoteRequestEmail(row?.id ?? '', 'nonsense')).toBe('gone');
      await db.update(schema.salesQuotes).set({ source: 'staff' }).where(eq(schema.salesQuotes.id, row?.id ?? ''));
      expect(await sendQuoteRequestEmail(row?.id ?? '', 'staff')).toBe('gone');
    });

    it('queues the staff alert and the shopper confirmation for every request (who they go to is decided when they are sent)', async () => {
      const queued: string[] = [];
      const service = new (await import('./package-quote-request-service')).PackageQuoteRequestService(db, c.packageShop, c.packageOrders, quotes, (id) => {
        queued.push(id);
        return Promise.resolve();
      });
      const q = await lunch('quote');
      const line = { productId: q.p.lunch, picks: q.picks as never, servings: 3 };
      const base = { line, name: 'Mail Test', email: '', phone: '0712345678', neededOn: '', message: '' };
      expect((await service.request(companyId, null, base)).ok).toBe(true);
      expect((await service.request(companyId, null, { ...base, email: `q-${randomUUID().slice(0, 6)}@pkg.test` })).ok).toBe(true);
      expect(queued).toHaveLength(2);
    });

    it('does not fail the request when the mails cannot be queued', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const service = new (await import('./package-quote-request-service')).PackageQuoteRequestService(db, c.packageShop, c.packageOrders, quotes, () => Promise.reject(new Error('queue is down')));
        const q = await lunch('quote');
        const made = await service.request(companyId, null, { line: { productId: q.p.lunch, picks: q.picks, servings: 2 }, name: 'Queue Down', email: 'down@pkg.test', phone: '', neededOn: '', message: '' });
        expect(made.ok).toBe(true);
        expect(log).toHaveBeenCalled();
      } finally {
        log.mockRestore();
      }
    });
  });
});
