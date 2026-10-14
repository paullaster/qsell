import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { drizzleDb as Db } from '@/server/db/drizzle/client';
import type * as Schema from '@/server/db/drizzle/schema';
import type { SalesQuoteService } from './service';
import type { SectionTemplateService } from './section-template-service';
import type { TemplateSwapService } from './template-swap-service';

/**
 * Switching templates, decided on the server: what the dialog is told, and the form both ways.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL ?? '';
if (url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === '')('template switching on the server (database)', () => {
  let db: typeof Db;
  let schema: typeof Schema;
  let quotes: SalesQuoteService;
  let sections: SectionTemplateService;
  let swaps: TemplateSwapService;
  let userId: string;
  let itemTypeId: string;
  let p: Record<string, string> = {};

  const product = async (name: string, price: string) => {
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({
      id,
      sku: `S-${randomUUID().slice(0, 8)}`.toUpperCase(),
      stockCode: `SS-${randomUUID().slice(0, 8)}`.toUpperCase(),
      name,
      slug: `s-${randomUUID()}`,
      itemTypeId,
      price,
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
    await c.organizations.ensureDefaultOrgAndBranch(company.id, 'Swap Svc Co');
    itemTypeId = `it_ts_${randomUUID().slice(0, 8)}`;
    await db
      .insert(schema.itemTypes)
      .values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    await db
      .insert(schema.currencies)
      .values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true })
      .onConflictDoNothing();
    userId = (
      await db
        .insert(schema.users)
        .values({
          email: `ts-${randomUUID()}@t.test`,
          passwordHash: 'x',
          name: 'T',
          role: 'manager',
        })
        .returning()
    )[0].id;
    p = {
      rice: await product('Rice', '600'),
      sugar: await product('Sugar', '180'),
      flour: await product('Flour', '200'),
      salt: await product('Salt', '50'),
    };
    const { SalesQuoteService } = await import('./service');
    const { SectionTemplateService } = await import('./section-template-service');
    const { TemplateSwapService } = await import('./template-swap-service');
    quotes = new SalesQuoteService();
    sections = new SectionTemplateService();
    swaps = new TemplateSwapService();
  });

  const line = (productId: string, qty = 1) => ({
    sectionId: null,
    productId,
    quantity: qty,
    priceMode: 'catalog' as const,
    discountPercent: 0,
  });
  const quoteTemplate = (name: string, productId: string, over: Record<string, unknown> = {}) =>
    quotes.saveTemplate(userId, null, {
      name: `${name} ${randomUUID().slice(0, 6)}`,
      currency: 'KES',
      paymentMethod: 'mpesa_daraja',
      showBillingAddress: false,
      validityDays: 30,
      quoteDiscountPercent: 0,
      shippingFee: 0,
      tags: [],
      isDefault: false,
      sections: [],
      lines: [line(productId, 2)],
      ...over,
    });
  const form = (over: Record<string, unknown> = {}) =>
    ({
      customerName: 'Buyer',
      currency: 'KES',
      paymentMethod: 'mpesa_daraja',
      discountPercent: 0,
      shippingFee: 0,
      sections: [],
      lines: [],
      ...over,
    }) as never;
  const fl = (productId: string, extra: Record<string, unknown> = {}) => ({
    productId,
    quantity: 1,
    discountPercent: 0,
    ...extra,
  });

  it('describes a switch with the names the dialog shows, and returns the form both ways', async () => {
    const a = await quoteTemplate('Pack A', p.rice);
    const b = await quoteTemplate('Pack B', p.flour);
    const current = form({
      templateId: a.id,
      sections: [{ id: 's1', title: 'Extras' }],
      lines: [fl(p.rice, { fromTemplate: true, quantity: 5 }), fl(p.salt, { sectionId: 's1' })],
    });
    const summary = await swaps.planQuoteSwap(current, b.id);
    expect(summary).toMatchObject({
      kind: 'additions',
      fromName: a.name,
      toName: b.name,
      replacedLines: 1,
      edited: [{ key: expect.any(String) as string, name: 'Rice' }],
      additions: {
        items: [],
        sections: [{ key: 's1', title: 'Extras', items: 1 }],
      },
    });
    expect(summary.keep.templateId).toBe(b.id);
    expect(summary.keep.templateName).toBe(b.name);
    expect(summary.keep.lines.map((l) => l.productId).sort()).toEqual([p.flour, p.salt].sort());
    expect(summary.drop.lines.map((l) => l.productId)).toEqual([p.flour]);
  });

  it('refuses a template that is gone, archived, or already on the quote', async () => {
    const a = await quoteTemplate('Pack C', p.rice);
    const gone = randomUUID();
    await expect(swaps.planQuoteSwap(form(), gone)).rejects.toThrow(/no longer available/);
    await quotes.archiveTemplate(userId, a.id);
    await expect(swaps.planQuoteSwap(form(), a.id)).rejects.toThrow(/Archived/);
    // An archived template already on the quote can stay: switching away from it is allowed.
    const b = await quoteTemplate('Pack D', p.flour);
    await expect(swaps.planQuoteSwap(form({ templateId: a.id }), b.id)).resolves.toBeTruthy();
    await expect(swaps.planQuoteSwap(form({ templateId: b.id }), b.id)).rejects.toThrow(/already/);
  });

  it('a blank form with no customer simply becomes the template, customer and all', async () => {
    const trade = await quoteTemplate('Pack E', p.sugar, { shippingFee: 300 });
    const blank = form({ customerName: '', customerId: null });
    const summary = await swaps.planQuoteSwap(blank, trade.id);
    expect(summary.kind).toBe('none');
    expect(summary.drop.templateId).toBe(trade.id);
    expect(summary.drop.shippingFee).toBe(300);
    expect(summary.drop.lines.map((l) => l.productId)).toEqual([p.sugar]);
    expect(summary.keep).toEqual(summary.drop);
  });

  it('adds a section from a section template, and names it', async () => {
    const st = await sections.save(userId, null, {
      name: `Baking ${randomUUID().slice(0, 6)}`,
      sectionTitle: 'Baking',
      showLines: true,
      lines: [{ productId: p.flour, quantity: 3, priceMode: 'catalog', discountPercent: 0 }],
    });
    const next = await swaps.addSection(form({ lines: [fl(p.rice)] }), st.id);
    expect(next.sections).toHaveLength(1);
    expect(next.sections[0]).toMatchObject({
      title: 'Baking',
      sectionTemplateId: st.id,
      sectionTemplateName: st.name,
    });
    expect(next.lines.filter((l) => l.sectionId === next.sections[0].id)).toHaveLength(1);
    await expect(swaps.addSection(form(), randomUUID())).rejects.toThrow(/no longer available/);
    await sections.archive(userId, st.id);
    await expect(swaps.addSection(form(), st.id)).rejects.toThrow(/Archived/);
  });

  it('switches one section’s template and leaves the rest of the quote alone', async () => {
    const mk = (name: string, productId: string, title: string) =>
      sections.save(userId, null, {
        name: `${name} ${randomUUID().slice(0, 6)}`,
        sectionTitle: title,
        showLines: false,
        lines: [{ productId, quantity: 1, priceMode: 'catalog', discountPercent: 0 }],
      });
    const from = await mk('Tea', p.sugar, 'Tea time');
    const to = await mk('Snack', p.salt, 'Snacks');
    const start = await swaps.addSection(form({ lines: [fl(p.rice)] }), from.id);
    const sectionId = start.sections[0].id;
    const withExtra = {
      ...start,
      lines: [...start.lines, fl(p.flour, { sectionId })],
    };
    const summary = await swaps.planSectionSwap(withExtra, sectionId, to.id);
    expect(summary).toMatchObject({
      kind: 'additions',
      fromName: from.name,
      toName: to.name,
      additions: { items: [{ key: expect.any(String) as string, name: 'Flour' }], sections: [] },
    });
    const kept = summary.keep.lines
      .filter((l) => l.sectionId === sectionId)
      .map((l) => l.productId);
    expect(kept.sort()).toEqual([p.flour, p.salt].sort());
    expect(summary.drop.lines.some((l) => l.productId === p.rice)).toBe(true);
    expect(summary.drop.sections[0]).toMatchObject({
      title: 'Snacks',
      sectionTemplateId: to.id,
      sectionTemplateName: to.name,
    });
    await expect(swaps.planSectionSwap(withExtra, 'nope', to.id)).rejects.toThrow(/no longer on/);
    await expect(swaps.planSectionSwap(withExtra, sectionId, from.id)).rejects.toThrow(/already/);
  });

  it('starts a new quote from the default template, or says there is none', async () => {
    const before = await swaps.defaultDraft();
    const d = await quoteTemplate('Default', p.rice, {
      isDefault: true,
      termsAndConditions: 'T&C',
    });
    const draft = await swaps.defaultDraft();
    expect(draft?.templateId).toBe(d.id);
    expect(draft?.termsAndConditions).toBe('T&C');
    if (before === null) expect(draft).not.toBeNull();
  });
});
