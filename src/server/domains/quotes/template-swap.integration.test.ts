import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

/**
 * Switching the template of a saved quote: what came from the template is remembered, a switch is
 * recorded on the quote, and the new template's usage is counted.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;

describe.skipIf(!url)('switching a quote template (database)', () => {
  let db: typeof import('@/server/db/drizzle/client').drizzleDb;
  let schema: typeof import('@/server/db/drizzle/schema');
  let svc: import('./service').SalesQuoteService;
  let userId: string;
  let itemTypeId: string;

  const product = async (name: string) => {
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({
      id,
      sku: `W-${randomUUID().slice(0, 8)}`.toUpperCase(),
      stockCode: `WS-${randomUUID().slice(0, 8)}`.toUpperCase(),
      name,
      slug: `w-${randomUUID()}`,
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
    itemTypeId = `it_w_${randomUUID().slice(0, 8)}`;
    await db
      .insert(schema.itemTypes)
      .values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    await db
      .insert(schema.currencies)
      .values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true })
      .onConflictDoNothing();
    await c.organizations.ensureDefaultOrgAndBranch(company.id, 'Swap Co');
    userId = (
      await db
        .insert(schema.users)
        .values({
          email: `w-${randomUUID()}@w.test`,
          passwordHash: 'x',
          name: 'Swap',
          role: 'manager',
        })
        .returning()
    )[0]!.id;
    const { SalesQuoteService } = await import('./service');
    svc = new SalesQuoteService();
  });

  const line = (productId: string, sectionId: string | null = null) => ({
    sectionId,
    productId,
    quantity: 1,
    priceMode: 'catalog' as const,
    discountPercent: 0,
  });
  const template = (productId: string) =>
    svc.saveTemplate(userId, null, {
      name: `Swap ${randomUUID().slice(0, 8)}`,
      currency: 'KES',
      paymentMethod: 'mpesa_daraja' as never,
      showBillingAddress: false,
      validityDays: 30,
      quoteDiscountPercent: 0,
      shippingFee: 0,
      tags: [],
      isDefault: false,
      sections: [],
      lines: [line(productId)],
    } as never);

  it('remembers what came from the template, and records and counts a switch', async () => {
    const [rice, flour, salt] = await Promise.all(['Rice', 'Flour', 'Salt'].map(product));
    const a = await template(rice!);
    const b = await template(flour!);
    const SEC = randomUUID();
    const base = {
      customerName: 'Swap Buyer',
      currency: 'KES',
      paymentMethod: 'mpesa_daraja' as never,
      discountPercent: 0,
      shippingFee: 0,
      deliveryAddress: { street: '1', city: 'N', countyOrState: 'N', country: 'KE' },
    };
    const created = await svc.create(userId, {
      ...base,
      templateId: a.id,
      sections: [{ id: SEC, title: 'Extras' }],
      lines: [{ ...line(rice!), fromTemplate: true }, line(salt!, SEC)],
    });
    expect(created.sections.map((s) => s.fromTemplate)).toEqual([false]);
    expect(Object.fromEntries(created.lines.map((l) => [l.productId, l.fromTemplate]))).toEqual({
      [rice!]: true,
      [salt!]: false,
    });

    const switched = await svc.update(userId, created.id, {
      ...base,
      templateId: b.id,
      sections: [{ id: SEC, title: 'Extras' }],
      lines: [{ ...line(flour!), fromTemplate: true }, line(salt!, SEC)],
    });
    expect(switched.templateId).toBe(b.id);
    expect(switched.templateName).toBe(b.name);
    expect(switched.lines.map((l) => l.productId).sort()).toEqual([flour, salt].sort());
    const event = switched.events.find((e) => e.eventType === 'template_changed');
    expect(event?.details).toMatchObject({ fromTemplateId: a.id, toTemplateId: b.id });
    const [{ usageCount }] = await db
      .select()
      .from(schema.salesQuoteTemplates)
      .where(eq(schema.salesQuoteTemplates.id, b.id));
    expect(usageCount).toBe(1);

    // Saving again without switching records nothing new and counts nothing.
    const again = await svc.update(userId, created.id, {
      ...base,
      templateId: b.id,
      sections: [{ id: SEC, title: 'Extras' }],
      lines: [{ ...line(flour!), fromTemplate: true }, line(salt!, SEC)],
    });
    expect(again.events.filter((e) => e.eventType === 'template_changed')).toHaveLength(1);
  });
});
