import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { getContainer } from '@/server/di/container';
import type { drizzleDb } from '@/server/db/drizzle/client';
import type * as schemaModule from '@/server/db/drizzle/schema';
import type { SalesQuoteService } from '@/server/domains/quotes/service';
import { PACKAGE_DOCUMENT_TYPES, type PackageDocumentType } from './domain/package-documents';
import type { StoredPick } from './domain/package-shop';

/**
 * The same package cases run against every document type that can sell a package (the registry in domain/package-documents.ts).
 * A new place of sale (point of sale, sales order, sales invoice, credit sale) is not finished until it has an adapter here.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (url !== undefined && url !== '') process.env.DATABASE_URL = url;

/** What a document type does with a package line, in the terms every type shares. */
interface Adapter {
  /** Sells the package; returns what the document came to, or the reason it was refused. */
  sell(input: { productId: string; servings: number; picks: StoredPick[] }): Promise<{ ok: true; total: number; tax: number; parts: Record<string, number> } | { ok: false; error: string }>;
}

describe.skipIf(url === undefined || url === '')('a package sold by every document type (database)', () => {
  let c: ReturnType<typeof getContainer>;
  let db: typeof drizzleDb;
  let schema: typeof schemaModule;
  let quotes: SalesQuoteService;
  let companyId: string;
  let itemTypeId: string;
  let branchId: string;
  const actor = { type: 'user' as const, id: 'package-documents-test' };
  const reason = { code: 'POLICY_CHANGE' };

  const product = async (over: Record<string, unknown> = {}) => {
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({
      id,
      sku: `PD-${randomUUID().slice(0, 8)}`.toUpperCase(),
      stockCode: `PDS-${randomUUID().slice(0, 8)}`.toUpperCase(),
      name: `Doc part ${randomUUID().slice(0, 4)}`,
      slug: `pd-${randomUUID()}`,
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

  const adapters = (): Record<PackageDocumentType, Adapter> => ({
    order: {
      async sell({ productId, servings, picks }) {
        const resolved = await c.packageOrders.resolve(companyId, [{ productId, stored: picks }]);
        if (!resolved.ok) return { ok: false, error: resolved.error };
        const { OrderWriteService } = await import('@/server/domains/orders/write-service');
        const result = await OrderWriteService.createOrder({
          branchId,
          orderNumber: `PD-${randomUUID()}`,
          customerName: 'Doc Buyer',
          customerEmail: `pd-${randomUUID()}@pkg.test`,
          customerPhone: '0700000000',
          shippingAddress: { street: '1 Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' },
          items: [{ productId, quantity: servings, package: { picks: resolved.picks[0] ?? [] } }],
          currency: 'KES',
          paymentMethod: 'mpesa_daraja',
        });
        if (!result.success || result.order === undefined) return { ok: false, error: result.error ?? 'refused' };
        return { ok: true, total: result.order.totalAmount, tax: result.order.tax, parts: Object.fromEntries(result.order.items.map((i) => [i.productId, i.quantity])) };
      },
    },
    quote: {
      async sell({ productId, servings, picks }) {
        try {
          const author = (await db.insert(schema.users).values({ email: `pd-${randomUUID()}@pkg.test`, passwordHash: 'x', name: 'Doc Author', role: 'manager' }).returning())[0];
          if (author === undefined) throw new Error('no user');
          const q = await quotes.create(author.id, { customerId: null, customerName: 'Doc Quote Buyer', customerEmail: `pdq-${randomUUID()}@pkg.test`, currency: 'KES', paymentMethod: 'mpesa_daraja', discountPercent: 0, shippingFee: 0, sections: [], lines: [{ productId, quantity: servings, discountPercent: 0, priceMode: 'catalog', package: { picks } }] } as never);
          await db.update(schema.salesQuotes).set({ status: 'accepted', deliveryAddress: { street: '1 Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' } }).where(eq(schema.salesQuotes.id, q.id));
          const order = await quotes.convertToOrder(author.id, q.id);
          if (order === null) return { ok: false, error: 'not converted' };
          // A quote's own totals and the order made from it agree.
          expect(order.totalAmount).toBeCloseTo(Number(q.totalAmount), 1);
          return { ok: true, total: Number(q.totalAmount), tax: Number(q.taxAmount), parts: Object.fromEntries(order.items.map((i) => [i.productId, i.quantity])) };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : 'refused' };
        }
      },
    },
  });

  const lunch = async () => {
    const p = {
      lunch: await product({ name: 'Doc lunch', price: '650', inventoryKind: 'non_inventory', stockQuantity: 0 }),
      small: await product({ name: 'Doc small fish', price: '300', costPrice: '150', taxRate: '16', stockQuantity: 30 }),
      large: await product({ name: 'Doc large fish', price: '420', costPrice: '200', taxRate: '16', stockQuantity: 30 }),
      ugali: await product({ name: 'Doc ugali', price: '50', costPrice: '20', soldOnlyInPackages: true, showOnWebShop: false, stockQuantity: 30 }),
      sukuma: await product({ name: 'Doc sukuma', price: '40', costPrice: '15', stockQuantity: 30 }),
    };
    await c.packageConfig.save(
      companyId,
      {
        productId: p.lunch,
        pricingMode: 'base_plus_differences',
        allocation: 'list_price',
        shortStockMode: 'hide',
        slots: [
          { name: 'Fish', minPicks: 1, maxPicks: 1, options: [{ productId: p.small, quantity: 1 }, { productId: p.large, quantity: 1, difference: 120 }] },
          { name: 'Starch', minPicks: 1, maxPicks: 1, options: [{ productId: p.ugali, quantity: 1 }] },
          { name: 'Vegetables', minPicks: 1, maxPicks: 2, options: [{ productId: p.sukuma, quantity: 1 }] },
        ],
      },
      actor,
      reason,
    );
    const picks = (fish: 'small' | 'large'): StoredPick[] => [
      { slotName: 'Fish', productId: p[fish], name: fish, count: 1 },
      { slotName: 'Starch', productId: p.ugali, name: 'ugali', count: 1 },
      { slotName: 'Vegetables', productId: p.sukuma, name: 'sukuma', count: 1 },
    ];
    return { p, picks };
  };

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    quotes = new (await import('@/server/domains/quotes/service')).SalesQuoteService();
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    itemTypeId = `it_pd_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    const { branch } = await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Package Documents Co');
    branchId = ((await c.branches.getDefault(companyId)) ?? branch).id;
  });

  it('has an adapter for every registered document type, and for no other', () => {
    expect(Object.keys(adapters()).sort()).toEqual(PACKAGE_DOCUMENT_TYPES.map((t) => t.type).sort());
  });

  for (const { type, label } of PACKAGE_DOCUMENT_TYPES) {
    describe(`${label} (${type})`, () => {
      it('sells a package for the same price, the same tax and the same parts as every other type', async () => {
        const { p, picks } = await lunch();
        const sold = await adapters()[type].sell({ productId: p.lunch, servings: 3, picks: picks('large') });
        expect(sold.ok).toBe(true);
        if (!sold.ok) return;
        // 650 + 120 for the large fish, three servings; only the fish carries tax.
        expect(sold.total).toBeCloseTo(770 * 3, 1);
        expect(sold.tax).toBeGreaterThan(0);
        expect(sold.tax).toBeLessThan((770 * 3 * 16) / 116);
        expect(sold.parts).toEqual({ [p.large]: 3, [p.ugali]: 3, [p.sukuma]: 3 });
      });

      it('refuses a choice the package does not offer', async () => {
        const { p, picks } = await lunch();
        const foreign = await lunch();
        const bad = [...picks('small').slice(0, 2), ...foreign.picks('small').slice(2)];
        const sold = await adapters()[type].sell({ productId: p.lunch, servings: 1, picks: bad });
        expect(sold.ok).toBe(false);
      });

      it('refuses a package product sold with no choices, and servings that are not whole numbers from one', async () => {
        const { p, picks } = await lunch();
        expect((await adapters()[type].sell({ productId: p.lunch, servings: 1, picks: [] })).ok).toBe(false);
        for (const servings of [0, -1, 1.5]) expect((await adapters()[type].sell({ productId: p.lunch, servings, picks: picks('small') })).ok).toBe(false);
      });
    });
  }
});
