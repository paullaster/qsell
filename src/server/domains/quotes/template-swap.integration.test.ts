import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { drizzleDb as Db } from '@/server/db/drizzle/client';
import type * as Schema from '@/server/db/drizzle/schema';
import type { SalesQuoteService } from './service';
import { eq } from 'drizzle-orm';

/**
 * Switching the template of a saved quote: what came from the template is remembered, a switch is
 * recorded on the quote, and the new template's usage is counted.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL ?? '';
if (url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === '')('switching a quote template (database)', () => {
  let db: typeof Db;
  let schema: typeof Schema;
  let svc: SalesQuoteService;
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
    )[0].id;
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
      paymentMethod: 'mpesa_daraja',
      showBillingAddress: false,
      validityDays: 30,
      quoteDiscountPercent: 0,
      shippingFee: 0,
      tags: [],
      isDefault: false,
      sections: [],
      lines: [line(productId)],
    });

  it('remembers what came from the template, and records and counts a switch', async () => {
    const [rice, flour, salt] = await Promise.all(['Rice', 'Flour', 'Salt'].map(product));
    const a = await template(rice);
    const b = await template(flour);
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
      lines: [{ ...line(rice), fromTemplate: true }, line(salt, SEC)],
    });
    expect(created.sections.map((s) => s.fromTemplate)).toEqual([false]);
    expect(Object.fromEntries(created.lines.map((l) => [l.productId, l.fromTemplate]))).toEqual({
      [rice]: true,
      [salt]: false,
    });

    const switched = await svc.update(userId, created.id, {
      ...base,
      templateId: b.id,
      sections: [{ id: SEC, title: 'Extras' }],
      lines: [{ ...line(flour), fromTemplate: true }, line(salt, SEC)],
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
      lines: [{ ...line(flour), fromTemplate: true }, line(salt, SEC)],
    });
    expect(again.events.filter((e) => e.eventType === 'template_changed')).toHaveLength(1);
  });

  it('saves sections made from section templates, counts their use and records a switch', async () => {
    const { SectionTemplateService } = await import('./section-template-service');
    const sts = new SectionTemplateService();
    const [tiles, grout] = await Promise.all(['Tiles', 'Grout'].map(product));
    const sectionTemplate = (name: string, productId: string) =>
      sts.save(userId, null, {
        name: `${name} ${randomUUID().slice(0, 8)}`,
        sectionTitle: name,
        showLines: true,
        lines: [{ productId, quantity: 2, priceMode: 'catalog', discountPercent: 0 }],
      });
    const a = await sectionTemplate('Floor', tiles);
    const b = await sectionTemplate('Finish', grout);
    const base = {
      customerName: 'Section Buyer',
      currency: 'KES',
      paymentMethod: 'mpesa_daraja' as never,
      discountPercent: 0,
      shippingFee: 0,
      deliveryAddress: { street: '1', city: 'N', countyOrState: 'N', country: 'KE' },
    };
    const S1 = randomUUID();
    const withTemplate = (templateId: string, productId: string) => ({
      ...base,
      sections: [{ id: S1, title: 'Floor', sectionTemplateId: templateId }],
      lines: [{ ...line(productId, S1), fromSectionTemplate: true }],
    });
    const created = await svc.create(userId, withTemplate(a.id, tiles));
    expect(created.sections[0]).toMatchObject({
      sectionTemplateId: a.id,
      sectionTemplateName: a.name,
      fromTemplate: false,
    });
    expect(created.lines[0].fromSectionTemplate).toBe(true);
    // A flag on a line outside any section template is not kept.
    const loose = await svc.create(userId, {
      ...base,
      sections: [],
      lines: [{ ...line(tiles), fromSectionTemplate: true }],
    });
    expect(loose.lines[0].fromSectionTemplate).toBe(false);
    const count = async (id: string) => (await sts.get(id))?.usageCount ?? -1;
    expect(await count(a.id)).toBe(1); // only the first quote used it

    // Saving the same quote again counts nothing; switching the section's template does.
    await svc.update(userId, created.id, withTemplate(a.id, tiles));
    expect(await count(a.id)).toBe(1);
    const switched = await svc.update(userId, created.id, withTemplate(b.id, grout));
    expect(switched.sections[0].sectionTemplateId).toBe(b.id);
    expect(await count(b.id)).toBe(1);
    const event = switched.events.find((e) => e.eventType === 'section_templates_changed');
    expect(event?.details).toMatchObject({
      added: [{ id: b.id }],
      removed: [{ id: a.id }],
    });

    // An archived section template cannot start a new section, but stays on one that has it.
    await sts.archive(userId, b.id);
    await expect(svc.create(userId, withTemplate(b.id, grout))).rejects.toThrow(/Archived/);
    await svc.update(userId, created.id, withTemplate(b.id, grout));
  });
});
