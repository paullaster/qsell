import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { drizzleDb as Db } from '@/server/db/drizzle/client';
import type * as Schema from '@/server/db/drizzle/schema';
import type { SalesQuoteService } from './service';
import type { SectionTemplateService } from './section-template-service';
import type { QuoteFormService } from './quote-form-service';
import { parseTemplateListRequest } from './template-list';

/**
 * The template management lists and the default-customer choice, against a real database.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL ?? '';
if (url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === '')('template lists (database)', () => {
  let db: typeof Db;
  let schema: typeof Schema;
  let quotes: SalesQuoteService;
  let sections: SectionTemplateService;
  let form: QuoteFormService;
  let userId: string;
  let productId: string;
  let creditCustomer: string;
  const tag = randomUUID().slice(0, 6);

  const quotePage = async (raw: Record<string, unknown>) => {
    const parsed = parseTemplateListRequest({ query: tag, ...raw });
    if (!parsed.ok) throw new Error(parsed.error);
    return await quotes.listTemplatesPage(parsed.value);
  };
  const sectionPage = async (raw: Record<string, unknown>) => {
    const parsed = parseTemplateListRequest({ query: tag, ...raw });
    if (!parsed.ok) throw new Error(parsed.error);
    return await sections.listPage(parsed.value);
  };

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    const c = mod.getContainer();
    await c.companySettings.ensureSeeded();
    // The most recently changed company is the active one: use the first company.
    const company = (
      await db
        .select()
        .from(schema.companySettings)
        .orderBy(asc(schema.companySettings.createdAt))
        .limit(1)
    ).at(0);
    if (company === undefined) throw new Error('seed');
    await db
      .update(schema.companySettings)
      .set({ updatedAt: new Date(Date.now() + 2000) })
      .where(eq(schema.companySettings.id, company.id));
    await c.reasonCodes.ensureSystemReasons(company.id);
    const itemTypeId = `it_tl_${tag}`;
    await db
      .insert(schema.itemTypes)
      .values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    productId = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({
      id: productId,
      sku: `TL-${tag}`.toUpperCase(),
      stockCode: `TLS-${tag}`.toUpperCase(),
      name: 'Template item',
      slug: `tl-${randomUUID()}`,
      itemTypeId,
      price: '100',
      costPrice: '50',
      taxRate: '0',
      isTaxInclusive: true,
      stockQuantity: 100,
    });
    userId = (
      await db
        .insert(schema.users)
        .values({ email: `tl-${tag}@t.test`, passwordHash: 'x', name: 'TL', role: 'manager' })
        .returning()
    )[0]?.id;
    creditCustomer = (
      await db
        .insert(schema.customers)
        .values({
          companyId: company.id,
          number: `TL${tag}`,
          name: `TL ${tag} Credit`,
          accountType: 'credit',
          creditLimit: '1000',
          street: '5 Lane',
          city: 'Nairobi',
        })
        .returning()
    )[0]?.id;
    const { SalesQuoteService: Quotes } = await import('./service');
    const { SectionTemplateService: Sections } = await import('./section-template-service');
    const { QuoteFormService: Form } = await import('./quote-form-service');
    quotes = new Quotes();
    sections = new Sections();
    form = new Form();

    const template = (name: string, over: Record<string, unknown> = {}) =>
      quotes.saveTemplate(userId, null, {
        name: `${tag} ${name}`,
        currency: 'KES',
        paymentMethod: 'mpesa_daraja',
        showBillingAddress: false,
        validityDays: 30,
        quoteDiscountPercent: 0,
        shippingFee: 0,
        tags: ['promo'],
        isDefault: false,
        sections: [],
        lines: [
          { sectionId: null, productId, quantity: 1, priceMode: 'catalog', discountPercent: 0 },
          { sectionId: null, productId, quantity: 2, priceMode: 'catalog', discountPercent: 0 },
        ],
        ...over,
      } as never);
    for (const n of ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']) await template(n);
    const archived = await template('Zulu', { category: `Seasonal-${tag}` });
    await quotes.archiveTemplate(userId, archived.id);
    await template('Customer pack', { customerId: creditCustomer });

    for (const n of ['One', 'Two', 'Three', 'Four']) {
      await sections.save(userId, null, {
        name: `${tag} ${n}`,
        sectionTitle: `Title ${n} ${tag}`,
        showLines: false,
        lines: [{ productId, quantity: 1, priceMode: 'catalog', discountPercent: 0 }],
      });
    }
  });

  it('lists quote templates as summaries with their item count and customer', async () => {
    const result = await quotePage({ limit: 50 });
    expect(result.rows).toHaveLength(7);
    const pack = result.rows.find((r) => r.name.endsWith('Customer pack'));
    expect(pack).toMatchObject({ customerName: `TL ${tag} Credit`, lineCount: 2, tags: ['promo'] });
    expect(result.rows.find((r) => r.name.endsWith('Alpha'))?.customerName).toBeNull();
    expect(result.rows.every((r) => !('lines' in r))).toBe(true);
  });

  it('filters by status and searches name, category and description', async () => {
    expect((await quotePage({ status: 'archived' })).rows.map((r) => r.name)).toEqual([
      `${tag} Zulu`,
    ]);
    expect((await quotePage({ status: 'active', limit: 50 })).rows).toHaveLength(6);
    expect((await quotePage({ query: `Seasonal-${tag}` })).rows.map((r) => r.name)).toEqual([
      `${tag} Zulu`,
    ]);
    expect((await quotePage({ query: `${tag} bravo` })).rows).toHaveLength(1);
    // A literal %, after this test's own tag so other tests' rows cannot match it.
    expect((await quotePage({ query: `${tag}%` })).rows).toHaveLength(0);
  });

  it('pages by cursor without repeating or skipping', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const next = await quotePage({ limit: 3, cursor });
      seen.push(...next.rows.map((r) => r.id));
      cursor = next.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(7);
    expect(seen).toEqual((await quotePage({ limit: 50 })).rows.map((r) => r.id));
  });

  it('lists section templates the same way', async () => {
    const all = await sectionPage({ limit: 50 });
    expect(all.rows).toHaveLength(4);
    expect(all.rows[0]).toMatchObject({ lineCount: 1 });
    // A section's own title is searched too.
    expect((await sectionPage({ query: `Title Three ${tag}` })).rows).toHaveLength(1);
    expect((await sectionPage({ query: `${tag} Three` })).rows).toHaveLength(1);
    const first = await sectionPage({ limit: 3 });
    const second = await sectionPage({ limit: 3, cursor: first.nextCursor });
    expect([...first.rows, ...second.rows]).toHaveLength(4);
    expect(second.nextCursor).toBeNull();
    const target = all.rows[0]?.id ?? '';
    await sections.archive(userId, target);
    expect((await sectionPage({ status: 'archived' })).rows.map((r) => r.id)).toEqual([target]);
  });

  it('reads one template in full for its editor, with the customer name', async () => {
    const row = (await quotePage({ query: `${tag} Customer pack` })).rows.at(0);
    const full = await quotes.getTemplate(row?.id ?? '');
    expect(full?.lines).toHaveLength(2);
    expect(full?.customerName).toBe(`TL ${tag} Credit`);
    expect((await quotes.getTemplate(randomUUID())) ?? null).toBeNull();
  });

  describe('choosing a template’s default customer', () => {
    const base = {
      name: 'x',
      currency: 'KES',
      paymentMethod: 'mpesa_daraja',
      lines: [],
    };
    it('fills the addresses, names the customer and puts a credit customer on account', async () => {
      const next = await form.chooseTemplateCustomer(base, creditCustomer);
      expect(next).toMatchObject({
        customerId: creditCustomer,
        customerName: `TL ${tag} Credit`,
        paymentMethod: 'on_account',
        billingAddress: { street: '5 Lane', city: 'Nairobi' },
      });
    });
    it('clearing it takes the template off account', async () => {
      const cleared = await form.chooseTemplateCustomer(
        { ...base, paymentMethod: 'on_account', customerId: creditCustomer },
        null,
      );
      expect(cleared).toMatchObject({
        customerId: null,
        customerName: null,
        paymentMethod: 'mpesa_daraja',
      });
    });
    it('refuses nonsense', async () => {
      await expect(form.chooseTemplateCustomer(base, 'nope')).rejects.toThrow(/from the list/);
      await expect(form.chooseTemplateCustomer(base, randomUUID())).rejects.toThrow(/no longer/);
      await expect(form.chooseTemplateCustomer('x', creditCustomer)).rejects.toThrow(
        /Invalid template/,
      );
    });
  });
});
