import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

/**
 * Making a template from a quote of any status, and finding that quote by searching.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;

describe.skipIf(!url)('templates from quotes (database)', () => {
  let db: typeof import('@/server/db/drizzle/client').drizzleDb;
  let schema: typeof import('@/server/db/drizzle/schema');
  let svc: import('./service').SalesQuoteService;
  let userId: string;
  let itemTypeId: string;

  const product = async (name: string, over: Record<string, unknown> = {}) => {
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({
      id,
      sku: `T-${randomUUID().slice(0, 8)}`.toUpperCase(),
      stockCode: `TS-${randomUUID().slice(0, 8)}`.toUpperCase(),
      name,
      slug: `t-${randomUUID()}`,
      itemTypeId,
      price: '100',
      costPrice: '50',
      taxRate: '0',
      isTaxInclusive: true,
      stockQuantity: 100,
      ...over,
    });
    return id;
  };

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    const c = mod.getContainer();
    const company = await c.companySettings.ensureSeeded();
    await c.reasonCodes.ensureSystemReasons(company.id);
    itemTypeId = `it_t_${randomUUID().slice(0, 8)}`;
    await db
      .insert(schema.itemTypes)
      .values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    await db
      .insert(schema.currencies)
      .values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true })
      .onConflictDoNothing();
    await c.organizations.ensureDefaultOrgAndBranch(company.id, 'Template Co');
    userId = (
      await db
        .insert(schema.users)
        .values({
          email: `t-${randomUUID()}@t.test`,
          passwordHash: 'x',
          name: 'Templater',
          role: 'manager',
        })
        .returning()
    )[0]!.id;
    const { SalesQuoteService } = await import('./service');
    svc = new SalesQuoteService();
  });

  const make = async (customerName: string, lines: unknown[], sections: unknown[] = []) =>
    svc.create(userId, {
      customerName,
      customerEmail: `${randomUUID()}@t.test`,
      currency: 'KES',
      paymentMethod: 'mpesa_daraja' as never,
      discountPercent: 0,
      shippingFee: 0,
      deliveryAddress: { street: '1', city: 'N', countyOrState: 'N', country: 'KE' },
      sections,
      lines,
    } as never);

  it('finds quotes by number, customer or email, and shows what a person needs to choose', async () => {
    const tag = `Zed${randomUUID().slice(0, 6)}`;
    const p = await product('Searchable');
    const q = await make(`${tag} Traders`, [{ productId: p, quantity: 3, discountPercent: 0 }]);
    const byCustomer = await svc.searchQuotes(tag);
    expect(byCustomer).toHaveLength(1);
    expect(byCustomer[0]).toMatchObject({
      id: q.id,
      quoteNumber: q.quoteNumber,
      customerName: `${tag} Traders`,
      status: 'draft',
      currency: 'KES',
      totalAmount: 300,
      expired: false,
    });
    expect((await svc.searchQuotes(q.quoteNumber.toLowerCase())).map((h) => h.id)).toContain(q.id);
    expect(await svc.searchQuotes(`${tag}-nothing`)).toEqual([]);
  });

  it('finds quotes of every status, and can narrow by status', async () => {
    const tag = `Sta${randomUUID().slice(0, 6)}`;
    const p = await product('Status item');
    const statuses = ['draft', 'sent', 'accepted', 'rejected', 'converted', 'cancelled', 'expired'];
    for (const status of statuses) {
      const q = await make(`${tag} ${status}`, [{ productId: p, quantity: 1, discountPercent: 0 }]);
      await db.update(schema.salesQuotes).set({ status }).where(eq(schema.salesQuotes.id, q.id));
    }
    const all = await svc.searchQuotes(tag);
    expect(all.map((h) => h.status).sort()).toEqual([...statuses].sort());
    expect((await svc.searchQuotes(tag, { status: 'converted' })).map((h) => h.status)).toEqual([
      'converted',
    ]);
  });

  it('marks an open quote past its date as expired, not a converted one', async () => {
    const tag = `Exp${randomUUID().slice(0, 6)}`;
    const p = await product('Exp item');
    const open = await make(`${tag} open`, [{ productId: p, quantity: 1, discountPercent: 0 }]);
    const done = await make(`${tag} done`, [{ productId: p, quantity: 1, discountPercent: 0 }]);
    const past = new Date(Date.now() - 86400_000);
    await db
      .update(schema.salesQuotes)
      .set({ validUntil: past })
      .where(eq(schema.salesQuotes.id, open.id));
    await db
      .update(schema.salesQuotes)
      .set({ validUntil: past, status: 'converted' })
      .where(eq(schema.salesQuotes.id, done.id));
    const hits = await svc.searchQuotes(tag);
    expect(hits.find((h) => h.id === open.id)!.expired).toBe(true);
    expect(hits.find((h) => h.id === done.id)!.expired).toBe(false);
  });

  it('a draft from a converted quote keeps its arrangement and saves as a template', async () => {
    const [a, b, c] = await Promise.all([product('Alpha'), product('Beta'), product('Gamma')]);
    const S = randomUUID();
    const q = await make(
      `Round ${randomUUID().slice(0, 6)}`,
      [
        { sectionId: S, productId: c, quantity: 2, discountPercent: 5 },
        {
          sectionId: null,
          productId: a,
          quantity: 1,
          discountPercent: 0,
          unitPrice: 77,
          priceMode: 'manual',
        },
        { sectionId: S, productId: b, quantity: 4, discountPercent: 0 },
      ],
      [{ id: S, title: 'Kit', description: 'The kit', showLines: true }],
    );
    await db
      .update(schema.salesQuotes)
      .set({ status: 'converted' })
      .where(eq(schema.salesQuotes.id, q.id));

    const draft = await svc.templateDraftFromQuote(q.id);
    expect(draft.quoteNumber).toBe(q.quoteNumber);
    expect(draft.skipped).toEqual([]);
    expect(draft.input.name).toBe(`${q.quoteNumber} template`);
    expect(draft.input.sections.map((s) => [s.title, s.showLines])).toEqual([['Kit', true]]);
    const inKit = draft.input.lines.filter((l) => l.sectionId === draft.input.sections[0]!.id);
    expect(inKit.map((l) => [l.productId, l.quantity, l.discountPercent])).toEqual([
      [c, 2, 5],
      [b, 4, 0],
    ]);
    expect(draft.input.lines.find((l) => l.productId === a)).toMatchObject({
      priceMode: 'fixed',
      unitPrice: 77,
      sectionId: null,
    });
    expect(draft.input.customerId).toBeNull();

    const saved = await svc.saveTemplate(userId, null, draft.input);
    const got = (await svc.getTemplate(saved.id))!;
    expect(got.lines).toHaveLength(3);
    expect(got.sections[0]).toMatchObject({ title: 'Kit', showLines: true });
  });

  it('reports items that can no longer be sold, and the template still saves without them', async () => {
    const [a, gone] = await Promise.all([product('Stays'), product('Withdrawn')]);
    const q = await make(`Skip ${randomUUID().slice(0, 6)}`, [
      { productId: a, quantity: 1, discountPercent: 0 },
      { productId: gone, quantity: 1, discountPercent: 0 },
    ]);
    await db.update(schema.products).set({ isSellable: false }).where(eq(schema.products.id, gone));
    const draft = await svc.templateDraftFromQuote(q.id);
    expect(draft.skipped).toEqual([
      { name: 'Withdrawn', reason: 'The product can no longer be sold.' },
    ]);
    expect(draft.input.lines.map((l) => l.productId)).toEqual([a]);
    await expect(svc.saveTemplate(userId, null, draft.input)).resolves.toBeTruthy();
  });

  it('can keep the customer, and suggests a free name when one is taken', async () => {
    const p = await product('Named');
    const customer = (
      await db
        .insert(schema.customers)
        .values({
          companyId: (
            await (
              await import('@/server/di/container')
            )
              .getContainer()
              .companySettings.ensureSeeded()
          ).id,
          number: `TC-${randomUUID().slice(0, 8)}`,
          name: 'Kept Customer',
          email: `${randomUUID()}@t.test`,
          accountType: 'cash',
        })
        .returning()
    )[0]!;
    const q = await svc.create(userId, {
      customerId: customer.id,
      customerName: customer.name,
      customerEmail: customer.email,
      currency: 'KES',
      paymentMethod: 'mpesa_daraja' as never,
      discountPercent: 0,
      shippingFee: 0,
      deliveryAddress: { street: '1', city: 'N', countyOrState: 'N', country: 'KE' },
      sections: [],
      lines: [{ productId: p, quantity: 1, discountPercent: 0 }],
    } as never);
    const first = await svc.templateDraftFromQuote(q.id, true);
    expect(first.input.customerId).toBe(customer.id);
    await svc.saveTemplate(userId, null, first.input);
    const second = await svc.templateDraftFromQuote(q.id, true);
    expect(second.input.name).toBe(`${q.quoteNumber} template (2)`);
  });

  it('refuses a quote that does not exist', async () => {
    await expect(svc.templateDraftFromQuote(randomUUID())).rejects.toThrow(/not found/);
  });
});
