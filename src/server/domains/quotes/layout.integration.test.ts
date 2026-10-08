import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

/**
 * The arrangement of a quote's and a template's items and sections survives saving, copying and
 * revising, and the "keep expanded on the printout" choice goes wherever the section goes.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;

describe.skipIf(!url)('quote and template layout (database)', () => {
  let db: typeof import('@/server/db/drizzle/client').drizzleDb;
  let schema: typeof import('@/server/db/drizzle/schema');
  let svc: import('./service').SalesQuoteService;
  let userId: string;
  let itemTypeId: string;

  const product = async (name: string) => {
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({
      id,
      sku: `L-${randomUUID().slice(0, 8)}`.toUpperCase(),
      stockCode: `LS-${randomUUID().slice(0, 8)}`.toUpperCase(),
      name,
      slug: `l-${randomUUID()}`,
      itemTypeId,
      price: '100',
      costPrice: '50',
      taxRate: '0',
      isTaxInclusive: true,
      stockQuantity: 100,
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
    itemTypeId = `it_l_${randomUUID().slice(0, 8)}`;
    await db
      .insert(schema.itemTypes)
      .values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    await db
      .insert(schema.currencies)
      .values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true })
      .onConflictDoNothing();
    await c.organizations.ensureDefaultOrgAndBranch(company.id, 'Layout Co');
    userId = (
      await db
        .insert(schema.users)
        .values({
          email: `l-${randomUUID()}@l.test`,
          passwordHash: 'x',
          name: 'Layout',
          role: 'manager',
        })
        .returning()
    )[0]!.id;
    const { SalesQuoteService } = await import('./service');
    svc = new SalesQuoteService();
  });

  const templateInput = (sections: unknown[], lines: unknown[]) => ({
    name: `Layout ${randomUUID().slice(0, 8)}`,
    currency: 'KES',
    paymentMethod: 'mpesa_daraja' as never,
    showBillingAddress: false,
    validityDays: 30,
    quoteDiscountPercent: 0,
    shippingFee: 0,
    tags: [],
    isDefault: false,
    sections,
    lines,
  });
  const quoteInput = (sections: unknown[], lines: unknown[]) => ({
    customerName: 'Layout Buyer',
    customerEmail: 'layout@l.test',
    currency: 'KES',
    paymentMethod: 'mpesa_daraja' as never,
    discountPercent: 0,
    shippingFee: 0,
    deliveryAddress: { street: '1', city: 'N', countyOrState: 'N', country: 'KE' },
    sections,
    lines,
  });

  it('a template keeps its items in the sections they were put in, in the order they were arranged', async () => {
    const [a, b, c, d] = await Promise.all(['A', 'B', 'C', 'D'].map(product));
    const S1 = randomUUID();
    const S2 = randomUUID();
    const t = await svc.saveTemplate(
      userId,
      null,
      templateInput(
        [
          { id: S2, title: 'Second first', showLines: false },
          { id: S1, title: 'First second', showLines: true },
        ],
        [
          { sectionId: S1, productId: a, quantity: 1, priceMode: 'catalog', discountPercent: 0 },
          { sectionId: null, productId: b, quantity: 1, priceMode: 'catalog', discountPercent: 0 },
          { sectionId: S2, productId: c, quantity: 1, priceMode: 'catalog', discountPercent: 0 },
          { sectionId: S1, productId: d, quantity: 1, priceMode: 'catalog', discountPercent: 0 },
        ],
      ) as never,
    );
    const got = (await svc.getTemplate(t.id))!;
    expect(got.sections.map((s) => [s.title, s.showLines])).toEqual([
      ['Second first', false],
      ['First second', true],
    ]);
    const inS1 = got.lines.filter((l) => l.sectionId === S1).map((l) => l.productId);
    expect(inS1).toEqual([a, d]);
    expect(got.lines.filter((l) => l.sectionId === S2).map((l) => l.productId)).toEqual([c]);
    expect(got.lines.filter((l) => !l.sectionId).map((l) => l.productId)).toEqual([b]);

    // Rearranged: d now before a, c moved into S1 first, b into S2.
    await svc.saveTemplate(userId, t.id, {
      ...templateInput(
        [
          { id: S1, title: 'First second', showLines: false },
          { id: S2, title: 'Second first', showLines: true },
        ],
        [
          { sectionId: S1, productId: c, quantity: 1, priceMode: 'catalog', discountPercent: 0 },
          { sectionId: S1, productId: d, quantity: 1, priceMode: 'catalog', discountPercent: 0 },
          { sectionId: S1, productId: a, quantity: 1, priceMode: 'catalog', discountPercent: 0 },
          { sectionId: S2, productId: b, quantity: 1, priceMode: 'catalog', discountPercent: 0 },
        ],
      ),
      name: got.name,
    } as never);
    const after = (await svc.getTemplate(t.id))!;
    expect(after.sections.map((s) => [s.title, s.showLines])).toEqual([
      ['First second', false],
      ['Second first', true],
    ]);
    expect(after.lines.filter((l) => l.sectionId === S1).map((l) => l.productId)).toEqual([
      c,
      d,
      a,
    ]);
    expect(after.lines.filter((l) => l.sectionId === S2).map((l) => l.productId)).toEqual([b]);
    expect(after.lines.filter((l) => !l.sectionId)).toEqual([]);
  });

  it('copying a template keeps the sections, their order and whether they stay expanded', async () => {
    const [a, b] = await Promise.all(['A', 'B'].map(product));
    const S = randomUUID();
    const t = await svc.saveTemplate(
      userId,
      null,
      templateInput(
        [{ id: S, title: 'Kept open', showLines: true }],
        [
          { sectionId: S, productId: b, quantity: 1, priceMode: 'catalog', discountPercent: 0 },
          { sectionId: S, productId: a, quantity: 1, priceMode: 'catalog', discountPercent: 0 },
        ],
      ) as never,
    );
    const copy = await svc.duplicateTemplate(userId, t.id);
    const got = (await svc.getTemplate(copy.id))!;
    expect(got.sections.map((s) => [s.title, s.showLines])).toEqual([['Kept open', true]]);
    expect(got.lines.map((l) => l.productId)).toEqual([b, a]);
    expect(got.lines.every((l) => l.sectionId === got.sections[0]!.id)).toBe(true);
  });

  it('a quote keeps its arrangement and the expanded choice, and so does a revision of it', async () => {
    const [a, b, c] = await Promise.all(['A', 'B', 'C'].map(product));
    const S1 = randomUUID();
    const S2 = randomUUID();
    const q = await svc.create(
      userId,
      quoteInput(
        [
          { id: S1, title: 'Open one', showLines: true },
          { id: S2, title: 'Collapsed one', showLines: false },
        ],
        [
          { sectionId: S1, productId: c, quantity: 1, discountPercent: 0 },
          { sectionId: null, productId: a, quantity: 1, discountPercent: 0 },
          { sectionId: S1, productId: b, quantity: 1, discountPercent: 0 },
        ],
      ) as never,
    );
    expect(q.sections.map((s) => [s.title, s.showLines])).toEqual([
      ['Open one', true],
      ['Collapsed one', false],
    ]);
    expect(q.lines.filter((l) => l.sectionId === S1).map((l) => l.productId)).toEqual([c, b]);

    const rev = await svc.revise(userId, q.id);
    expect(rev.sections.map((s) => [s.title, s.showLines])).toEqual([
      ['Open one', true],
      ['Collapsed one', false],
    ]);
    const open = rev.sections[0]!;
    expect(rev.lines.filter((l) => l.sectionId === open.id).map((l) => l.productId)).toEqual([
      c,
      b,
    ]);
  });

  it('the customer’s PDF is made for a quote with an expanded and a collapsed section', async () => {
    const [a, b] = await Promise.all(['A', 'B'].map(product));
    const S1 = randomUUID();
    const S2 = randomUUID();
    const q = await svc.create(
      userId,
      quoteInput(
        [
          { id: S1, title: 'Open', showLines: true },
          { id: S2, title: 'Closed', showLines: false },
        ],
        [
          { sectionId: S1, productId: a, quantity: 2, discountPercent: 0 },
          { sectionId: S2, productId: b, quantity: 1, discountPercent: 0 },
        ],
      ) as never,
    );
    const pdf = await svc.generatePdf(q.id);
    expect(pdf.filename).toBe(`${q.quoteNumber}.pdf`);
    expect(Buffer.from(pdf.pdfBase64, 'base64').subarray(0, 4).toString()).toBe('%PDF');
  });

  it('a section’s choice is stored on the section, not guessed', async () => {
    const a = await product('A');
    const S = randomUUID();
    const q = await svc.create(
      userId,
      quoteInput(
        [{ id: S, title: 'Plain' }],
        [{ sectionId: S, productId: a, quantity: 1, discountPercent: 0 }],
      ) as never,
    );
    const [row] = await db
      .select()
      .from(schema.salesQuoteSections)
      .where(eq(schema.salesQuoteSections.quoteId, q.id));
    expect(row!.showLines).toBe(false);
  });
});
