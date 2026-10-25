import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { has, nth } from '@/lib/values';
import type * as mod_client from '@/server/db/drizzle/client';
import type * as mod_schema from '@/server/db/drizzle/schema';
import type * as mod_service from './service';

/**
 * Revising a quote: the copy, the link back, and what is said when it cannot be done.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

describe.skipIf(!has(url))('revising a quote (database)', () => {
  let db: typeof mod_client.drizzleDb;
  let schema: typeof mod_schema;
  let svc: mod_service.SalesQuoteService;
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
    userId = nth(
      await db
        .insert(schema.users)
        .values({ email: `t-${randomUUID()}@t.test`, passwordHash: 'x', name: 'Reviser', role: 'manager' })
        .returning(),
      0,
    ).id;
    const { SalesQuoteService } = await import('./service');
    svc = new SalesQuoteService();
  });

  const make = async (over: Record<string, unknown> = {}) => {
    const productId = await product('Revisable');
    const quote = await svc.create(userId, {
      customerName: 'Revising Buyer',
      customerEmail: `${randomUUID()}@t.test`,
      currency: 'KES',
      paymentMethod: 'mpesa_daraja',
      discountPercent: 0,
      shippingFee: 0,
      deliveryAddress: { street: '1', city: 'N', countyOrState: 'N', country: 'KE' },
      sections: [],
      lines: [{ productId, quantity: 2, unitPrice: 100, discountPercent: 0 }],
      ...over,
    } as never);
    return { quote, productId };
  };

  it('makes a new draft with the same lines, and links the two both ways', async () => {
    const { quote } = await make();
    const revised = await svc.revise(userId, quote.id);
    expect(revised.id).not.toBe(quote.id);
    expect(revised.quoteNumber).not.toBe(quote.quoteNumber);
    expect(revised.revisedFromQuoteId).toBe(quote.id);
    expect(revised.lines).toHaveLength(1);
    expect(Number(revised.totalAmount)).toBe(Number(quote.totalAmount));
    const events = await db.select().from(schema.salesQuoteEvents).where(eq(schema.salesQuoteEvents.quoteId, quote.id));
    expect(events.map((e) => e.eventType)).toContain('revision_created');
  });

  it('can revise a quote whose date has passed', async () => {
    const { quote } = await make({ validUntil: '2020-01-01' });
    const revised = await svc.revise(userId, quote.id);
    expect(revised.revisedFromQuoteId).toBe(quote.id);
  });

  it('says plainly why a converted or cancelled quote, or a missing one, cannot be revised', async () => {
    const { quote } = await make();
    await db.update(schema.salesQuotes).set({ status: 'converted' }).where(eq(schema.salesQuotes.id, quote.id));
    await expect(svc.revise(userId, quote.id)).rejects.toThrow('A converted or cancelled quote cannot be revised.');
    await expect(svc.revise(userId, randomUUID())).rejects.toThrow('Quote not found.');
  });

  it('says which item is the problem when a product can no longer be sold', async () => {
    const { quote, productId } = await make();
    await db.update(schema.products).set({ isSellable: false }).where(eq(schema.products.id, productId));
    await expect(svc.revise(userId, quote.id)).rejects.toThrow(/Revisable|sell/i);
  });
});
