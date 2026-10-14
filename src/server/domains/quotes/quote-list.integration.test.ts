import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { drizzleDb as Db } from '@/server/db/drizzle/client';
import type * as Schema from '@/server/db/drizzle/schema';
import type { SalesQuoteService } from './service';
import { parseQuoteListRequest } from './quote-list';

/**
 * The quotes list from the database: filtering, search, expiry, company scoping, and paging by
 * cursor without a repeat or a gap.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL ?? '';
if (url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === '')('quotes list (database)', () => {
  let db: typeof Db;
  let schema: typeof Schema;
  let svc: SalesQuoteService;
  let userId: string;
  let productId: string;
  const ids: Record<string, string> = {};
  const tag = randomUUID().slice(0, 6);

  const page = async (raw: Record<string, unknown>) => {
    const parsed = parseQuoteListRequest({ query: tag, ...raw });
    if (!parsed.ok) throw new Error(parsed.error);
    return await svc.listPage(parsed.value);
  };

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    const c = mod.getContainer();
    await c.companySettings.ensureSeeded();
    // Earlier runs may have left other companies behind; the active one is the most recently
    // changed, so make the first company the active one.
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
    await c.organizations.ensureDefaultOrgAndBranch(company.id, 'List Co');
    await db
      .insert(schema.currencies)
      .values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true })
      .onConflictDoNothing();
    const itemTypeId = `it_ql_${tag}`;
    await db
      .insert(schema.itemTypes)
      .values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    productId = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({
      id: productId,
      sku: `QL-${tag}`.toUpperCase(),
      stockCode: `QLS-${tag}`.toUpperCase(),
      name: 'List item',
      slug: `ql-${randomUUID()}`,
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
        .values({ email: `ql-${tag}@t.test`, passwordHash: 'x', name: 'QL', role: 'manager' })
        .returning()
    )[0]?.id;
    const { SalesQuoteService: Service } = await import('./service');
    svc = new Service();

    const make = async (name: string, over: Record<string, unknown> = {}) => {
      const quote = await svc.create(userId, {
        customerName: `${tag} ${name}`,
        customerEmail: `${name.toLowerCase()}-${tag}@list.test`,
        currency: 'KES',
        paymentMethod: 'mpesa_daraja',
        discountPercent: 0,
        shippingFee: 0,
        deliveryAddress: { street: '1', city: 'N', countyOrState: 'N', country: 'KE' },
        sections: [],
        lines: [{ productId, quantity: 1, discountPercent: 0 }],
        customerReference: `REF-${tag}-${name}`,
        ...over,
      } as never);
      ids[name] = quote.id;
      return quote;
    };
    for (const name of ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf']) {
      await make(name);
    }
    const set = (name: string, values: Partial<typeof Schema.salesQuotes.$inferInsert>) =>
      db
        .update(schema.salesQuotes)
        .set(values)
        .where(eq(schema.salesQuotes.id, ids[name] ?? ''));
    await set('Bravo', { status: 'sent' });
    await set('Charlie', { status: 'sent', validUntil: new Date('2020-01-01') });
    await set('Delta', { status: 'cancelled', validUntil: new Date('2020-01-01') });
    await set('Echo', { status: 'accepted' });
    // A quote of another company must never appear.
    const other = (
      await db
        .insert(schema.companySettings)
        .values({
          legalName: `Other ${tag}`,
          tradingName: `Other ${tag}`,
          email: `o-${tag}@t.test`,
          phone: '0',
          streetAddress: '1',
          city: 'N',
          countyOrState: 'N',
          postalCode: '0',
          kraPin: `P${tag}`,
        })
        .returning()
    )[0]?.id;
    // The most recently changed company is the active one: make ours the active one again.
    await db
      .update(schema.companySettings)
      .set({ updatedAt: new Date(Date.now() + 5000) })
      .where(eq(schema.companySettings.id, company.id));
    const row = (
      await db.select().from(schema.salesQuotes).where(eq(schema.salesQuotes.id, ids.Alpha))
    ).at(0);
    if (row === undefined) throw new Error('seed');
    await db.insert(schema.salesQuotes).values({
      ...row,
      id: randomUUID(),
      companyId: other,
      quoteNumber: `OTHER-${tag}`,
      customerName: `${tag} Elsewhere`,
    });
  });

  it('lists the company’s quotes newest change first, and never another company’s', async () => {
    const result = await page({ limit: 50 });
    const names = result.rows.map((r) => r.customerName.replace(`${tag} `, ''));
    expect(names).not.toContain('Elsewhere');
    expect(names).toHaveLength(7);
    const times = result.rows.map((r) => r.updatedAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(result.nextCursor).toBeNull();
  });

  it('filters by status, and expired means past its date while still open', async () => {
    expect((await page({ status: 'accepted' })).rows.map((r) => r.customerName)).toEqual([
      `${tag} Echo`,
    ]);
    const expired = (await page({ status: 'expired' })).rows;
    // Charlie is sent and past its date; Delta is past its date but cancelled, so it is not.
    expect(expired.map((r) => r.customerName)).toEqual([`${tag} Charlie`]);
    expect(expired[0]?.expired).toBe(true);
    const all = (await page({ limit: 50 })).rows;
    expect(all.find((r) => r.customerName.endsWith('Delta'))?.expired).toBe(false);
    expect(all.find((r) => r.customerName.endsWith('Alpha'))?.expired).toBe(false);
  });

  it('searches number, customer, email and reference without treating % or _ as wildcards', async () => {
    expect((await page({ query: `${tag} Golf` })).rows).toHaveLength(1);
    expect((await page({ query: `golf-${tag}@list.test` })).rows).toHaveLength(1);
    expect((await page({ query: `REF-${tag}-Foxtrot` })).rows).toHaveLength(1);
    const number = (await page({ query: `${tag} Alpha` })).rows[0]?.quoteNumber ?? '';
    expect((await page({ query: number })).rows.map((r) => r.customerName)).toEqual([
      `${tag} Alpha`,
    ]);
    expect((await page({ query: '%' })).rows).toHaveLength(0);
    expect((await page({ query: `${tag} _lpha` })).rows).toHaveLength(0);
  });

  it('pages by cursor without repeating or skipping, and says when it is done', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const next = await page({ limit: 3, cursor });
      expect(next.rows.length).toBeLessThanOrEqual(3);
      seen.push(...next.rows.map((r) => r.id));
      cursor = next.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    const whole = (await page({ limit: 50 })).rows.map((r) => r.id);
    expect(seen).toEqual(whole);
  });

  it('keeps its place when quotes change time between pages', async () => {
    const first = await page({ limit: 3 });
    // Touching a quote that was already shown moves it to the top, not into the next page.
    const shown = first.rows[2]?.id ?? '';
    await db
      .update(schema.salesQuotes)
      .set({ updatedAt: new Date() })
      .where(eq(schema.salesQuotes.id, shown));
    const second = await page({ limit: 50, cursor: first.nextCursor });
    expect(second.rows.map((r) => r.id)).not.toContain(shown);
    expect(second.rows).toHaveLength(4);
  });
});
