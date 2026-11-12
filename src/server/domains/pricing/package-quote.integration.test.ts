import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { getContainer } from '@/server/di/container';
import type { drizzleDb } from '@/server/db/drizzle/client';
import type * as schemaModule from '@/server/db/drizzle/schema';
import type { SalesQuoteService } from '@/server/domains/quotes/service';

/**
 * Quoting a configurable package and turning the quote into an order, against a real database. A quote keeps the choices by slot
 * name and part, prices and taxes the line by its parts like an order does, and the order made from it agrees with it.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (url !== undefined && url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === undefined || url === '')('quoting a package (database)', () => {
  let c: ReturnType<typeof getContainer>;
  let db: typeof drizzleDb;
  let schema: typeof schemaModule;
  let quotes: SalesQuoteService;
  let companyId: string;
  let itemTypeId: string;
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
      costPrice: '0',
      taxRate: '0',
      isTaxInclusive: true,
      stockQuantity: 100,
      ...over,
    });
    return id;
  };
  const user = async () =>
    (await db.insert(schema.users).values({ email: `pq-${randomUUID()}@pkg.test`, passwordHash: 'x', name: 'Quote Author', role: 'manager' }).returning())[0] ?? (() => { throw new Error('no user'); })();

  /** Lunch at 650; fish (16% tax) small or large (+120); starch; vegetables 1 to 2. */
  const lunch = async (rules: Record<string, unknown> = {}) => {
    const p = {
      lunch: await product({ name: 'Quoted lunch', price: '650', inventoryKind: 'non_inventory', stockQuantity: 0 }),
      small: await product({ name: 'Q small fish', price: '300', costPrice: '150', taxRate: '16', stockQuantity: 50 }),
      large: await product({ name: 'Q large fish', price: '420', costPrice: '200', taxRate: '16', stockQuantity: 50 }),
      ugali: await product({ name: 'Q ugali', price: '50', costPrice: '20', soldOnlyInPackages: true, showOnWebShop: false, stockQuantity: 50 }),
      sukuma: await product({ name: 'Q sukuma', price: '40', costPrice: '15', stockQuantity: 50 }),
    };
    const save = (slots?: unknown[]) =>
      c.packageConfig.save(
        companyId,
        {
          productId: p.lunch,
          pricingMode: 'base_plus_differences',
          allocation: 'list_price',
          shortStockMode: 'hide',
          rules: { minServings: null, maxServings: null, noticeMinutes: null, closesDaysBefore: null, closesAtMinute: null, weekdays: [], dailyLimit: null, audience: 'anyone', groupIds: [], ...rules },
          slots: (slots ?? [
            { name: 'Fish', minPicks: 1, maxPicks: 1, options: [{ productId: p.small, quantity: 1 }, { productId: p.large, quantity: 1, difference: 120 }] },
            { name: 'Starch', minPicks: 1, maxPicks: 1, options: [{ productId: p.ugali, quantity: 1 }] },
            { name: 'Vegetables', minPicks: 1, maxPicks: 2, options: [{ productId: p.sukuma, quantity: 1 }] },
          ]) as never,
        },
        actor,
        reason,
      );
    await save();
    const stored = (fish: 'small' | 'large') => [
      { slotName: 'Fish', productId: p[fish], name: fish === 'small' ? 'Q small fish' : 'Q large fish', count: 1 },
      { slotName: 'Starch', productId: p.ugali, name: 'Q ugali', count: 1 },
      { slotName: 'Vegetables', productId: p.sukuma, name: 'Q sukuma', count: 1 },
    ];
    return { p, stored, save };
  };

  const input = (customerId: string | null, lines: unknown[], over: Record<string, unknown> = {}) => ({
    customerId,
    customerName: 'Package Quote Buyer',
    customerEmail: `pqb-${randomUUID()}@pkg.test`,
    currency: 'KES',
    paymentMethod: 'mpesa_daraja' as never,
    discountPercent: 0,
    shippingFee: 0,
    sections: [],
    lines,
    ...over,
  });
  const packageLine = (productId: string, servings: number, picks: unknown[]) => ({ productId, quantity: servings, discountPercent: 0, priceMode: 'catalog', package: { picks } });
  const converted = async (userId: string, id: string) => {
    const order = await quotes.convertToOrder(userId, id);
    if (order === null) throw new Error('the quote was not converted');
    return order;
  };
  const accept = async (id: string) =>
    await db.update(schema.salesQuotes).set({ status: 'accepted', deliveryAddress: { street: '1 Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' } }).where(eq(schema.salesQuotes.id, id));

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    const { SalesQuoteService: Service } = await import('@/server/domains/quotes/service');
    quotes = new Service();
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    itemTypeId = `it_pq_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Package Quote Co');
  });

  it('prices the line as the base plus the choices, reads like the choices, taxes each part and costs what the parts cost', async () => {
    const { p, stored } = await lunch();
    const author = await user();
    const q = await quotes.create(author.id, input(null, [packageLine(p.lunch, 3, stored('large'))]) as never);
    const line = q.lines[0];
    if (line === undefined) throw new Error('no line');
    expect(line.description).toBe('Quoted lunch: Q large fish, Q ugali and Q sukuma');
    expect(Number(line.unitPrice)).toBe(770);
    expect(Number(line.lineAmount)).toBeCloseTo(770 * 3, 2);
    // Only the fish carries tax (16%, inside the price); cost is the parts' cost per serving times servings.
    expect(Number(line.taxAmount)).toBeGreaterThan(0);
    expect(Number(line.taxAmount)).toBeLessThan((770 * 3 * 16) / 116);
    expect(Number(line.costAmount)).toBeCloseTo((200 + 20 + 15) * 3, 2);
    expect(line.priceTrace?.quotedAsPackage).toMatchObject({ name: 'Quoted lunch', servings: 3, picks: [{ slotName: 'Fish', name: 'Q large fish' }, { slotName: 'Starch' }, { slotName: 'Vegetables' }] });
  });

  it('shows the same figures while it is being typed as when it is saved', async () => {
    const { p, stored } = await lunch();
    const author = await user();
    const { QuoteFormService } = await import('@/server/domains/quotes/quote-form-service');
    const preview = await new QuoteFormService().previewTotals({ discountPercent: 0, shippingFee: 0, lines: [{ productId: p.lunch, quantity: 3, discountPercent: 0, package: { picks: stored('large') } }] });
    const saved = await quotes.create(author.id, input(null, [packageLine(p.lunch, 3, stored('large'))]) as never);
    expect(preview.total).toBeCloseTo(Number(saved.totalAmount), 1);
    expect(preview.tax).toBeCloseTo(Number(saved.taxAmount), 1);
    expect(preview.cost).toBeCloseTo((200 + 20 + 15) * 3, 2);
  });

  it('refuses a choice the package does not offer, and servings that are not whole', async () => {
    const { p, stored } = await lunch();
    const other = await lunch();
    const author = await user();
    await expect(quotes.create(author.id, input(null, [packageLine(p.lunch, 1, [...stored('small').slice(0, 2), ...other.stored('small').slice(2)])]) as never)).rejects.toThrow(/no longer offered/);
    await expect(quotes.create(author.id, input(null, [packageLine(p.lunch, 1.5, stored('small'))]) as never)).rejects.toThrow(/whole servings|Quantity/);
    await expect(quotes.create(author.id, input(null, [packageLine(p.lunch, 1, stored('small').slice(0, 2))]) as never)).rejects.toThrow(/Vegetables/);
  });

  it('keeps two lines of one package apart and does not fold them when it becomes an order', async () => {
    const { p, stored } = await lunch();
    const author = await user();
    const q = await quotes.create(author.id, input(null, [packageLine(p.lunch, 1, stored('small')), packageLine(p.lunch, 2, stored('large'))]) as never);
    expect(q.lines.map((l) => l.description)).toEqual(['Quoted lunch: Q small fish, Q ugali and Q sukuma', 'Quoted lunch: Q large fish, Q ugali and Q sukuma']);
    await accept(q.id);
    const order = await converted(author.id, q.id);
    // The parts are folded per product (the ugali of both), and the order agrees with the quote.
    const ugali = order.items.filter((i) => i.productId === p.ugali);
    expect(ugali).toHaveLength(1);
    expect(ugali[0]?.quantity).toBe(3);
    expect(order.totalAmount).toBeCloseTo(Number(q.totalAmount), 1);
    const instances = await db.select().from(schema.packageInstances).where(eq(schema.packageInstances.documentId, order.id));
    expect(instances.map((i) => [i.lineNo, i.servings]).sort()).toEqual([[1, 1], [2, 2]]);
  });

  it('turns a quote into an order that agrees with it, keeping its price when the base price has moved since', async () => {
    const { p, stored } = await lunch();
    const author = await user();
    const q = await quotes.create(author.id, input(null, [packageLine(p.lunch, 2, stored('large'))]) as never);
    await db.update(schema.products).set({ price: '900' }).where(eq(schema.products.id, p.lunch));
    await accept(q.id);
    const order = await converted(author.id, q.id);
    expect(order.subtotal + order.tax).toBeCloseTo(Number(q.subtotal) + Number(q.taxAmount), 1);
    expect(order.totalAmount).toBeCloseTo(Number(q.totalAmount), 1);
  });

  it('stops the conversion, naming the part, when the package no longer offers a choice, and holds nothing', async () => {
    const { p, stored, save } = await lunch();
    const author = await user();
    const q = await quotes.create(author.id, input(null, [packageLine(p.lunch, 1, stored('large'))]) as never);
    await save([
      { name: 'Fish', minPicks: 1, maxPicks: 1, options: [{ productId: p.small, quantity: 1 }] },
      { name: 'Starch', minPicks: 1, maxPicks: 1, options: [{ productId: p.ugali, quantity: 1 }] },
      { name: 'Vegetables', minPicks: 1, maxPicks: 2, options: [{ productId: p.sukuma, quantity: 1 }] },
    ]);
    await accept(q.id);
    await expect(quotes.convertToOrder(author.id, q.id)).rejects.toThrow(/Q large fish is no longer offered in Fish/);
    const [fish] = await db.select().from(schema.products).where(eq(schema.products.id, p.large));
    expect(Number(fish?.reservedQuantity)).toBe(0);
    // The quote still reads as it was, and can be reopened on its kept choices.
    const form = (await import('@/server/domains/quotes/quote-forms')).quoteFormOf((await quotes.get(q.id)) ?? (() => { throw new Error('quote missing'); })(), randomUUID);
    expect(form.lines[0]?.package?.picks[0]).toMatchObject({ slotName: 'Fish', name: 'Q large fish' });
  });

  it('uses the date the quote says it is needed on for the package rules when it becomes an order', async () => {
    const { p, stored } = await lunch({ dailyLimit: 5 });
    const author = await user();
    const date = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
    const make = async (servings: number, neededOn?: string) => {
      const q = await quotes.create(author.id, input(null, [packageLine(p.lunch, servings, stored('small'))], neededOn === undefined ? {} : { neededOn }) as never);
      await accept(q.id);
      return q;
    };
    expect((await make(3, date)).neededOn).toBe(date);
    const undated = await make(3);
    await expect(quotes.convertToOrder(author.id, undated.id)).rejects.toThrow(/choose the date/);
    const first = await make(3, date);
    expect((await converted(author.id, first.id)).id).toBeTruthy();
    const second = await make(3, date);
    await expect(quotes.convertToOrder(author.id, second.id)).rejects.toThrow(/Only 2 servings left/);
  });

  it('ignores stock when quoting, and checks it when the quote becomes an order', async () => {
    const { p, stored } = await lunch();
    const author = await user();
    const q = await quotes.create(author.id, input(null, [packageLine(p.lunch, 80, stored('small'))]) as never);
    expect(q.lines).toHaveLength(1);
    await accept(q.id);
    await expect(quotes.convertToOrder(author.id, q.id)).rejects.toThrow(/sold out|Q small fish/i);
  });
});
