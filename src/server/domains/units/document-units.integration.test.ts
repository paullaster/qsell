import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { drizzleDb as Db } from '@/server/db/drizzle/client';
import type * as Schema from '@/server/db/drizzle/schema';
import type * as CatalogModule from '@/server/domains/catalog/service';
import type { AppContainer } from '@/server/di/container';
import type { ProductWrite } from '@/types/index';
import { emptyUnitDraft } from '@/lib/unit-rules';

/**
 * Quantities with decimals, and lines typed in a unit of the product, against a real database:
 * stock in kilograms, a quote line of 3 crates, what the totals and the order keep of it.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL ?? '';
if (url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === '')('decimal stock and document line units (database)', () => {
  let db: typeof Db;
  let schema: typeof Schema;
  let c: AppContainer;
  let Catalog: (typeof CatalogModule)['CatalogService'];
  let itemTypeId: string;
  let branchId: string;
  let userId: string;
  let kg: string;
  let pcs: string;
  let crate: string;
  let otherPack: string;
  let fishId: string;
  let phoneId: string;
  const tag = randomUUID().slice(0, 6).toUpperCase();

  const product = (over: Partial<ProductWrite> = {}): ProductWrite => ({
    sku: `D${tag}${randomUUID().slice(0, 4)}`.toUpperCase(),
    stockCode: `T${tag}${randomUUID().slice(0, 4)}`.toUpperCase(),
    name: `Item ${tag}`,
    slug: `item-${randomUUID()}`,
    description: '',
    category: '',
    itemTypeId,
    itemTypeName: '',
    itemTypeCode: 0,
    isSellable: true,
    price: 100,
    costPrice: 50,
    taxRate: 0,
    isTaxInclusive: true,
    stockQuantity: 0,
    lowStockThreshold: 0,
    isActive: true,
    imageUrl: '',
    rating: 0,
    reviewCount: 0,
    tags: [],
    ...over,
  });
  const idOf = async (code: string) =>
    (await db.select().from(schema.unitsOfMeasure).where(eq(schema.unitsOfMeasure.code, code)))[0]
      ?.id ?? '';
  const stockOf = async (id: string) =>
    (await db.select().from(schema.products).where(eq(schema.products.id, id)))[0];

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    ({ CatalogService: Catalog } = await import('@/server/domains/catalog/service'));
    c = mod.getContainer();
    const company = await c.companySettings.ensureSeeded();
    await c.reasonCodes.ensureSystemReasons(company.id);
    branchId = (await c.organizations.ensureDefaultOrgAndBranch(company.id, 'Units Co')).branch.id;
    await db
      .insert(schema.currencies)
      .values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true })
      .onConflictDoNothing();
    itemTypeId = `it_du_${tag}`;
    await db
      .insert(schema.itemTypes)
      .values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    userId =
      (
        await db
          .insert(schema.users)
          .values({ email: `du-${tag}@t.test`, passwordHash: 'x', name: 'DU', role: 'manager' })
          .returning()
      )[0]?.id ?? '';
    kg = await idOf('KG');
    pcs = await idOf('PCS');
    const draft = (code: string) => ({
      ...emptyUnitDraft(),
      kind: 'packaging',
      code: `${tag}${code}`,
      name: `${code} ${tag}`,
      decimals: '0',
    });
    crate = (await c.unitWriter.create(draft('CR'))).id;
    otherPack = (await c.unitWriter.create(draft('BG'))).id;
    const fish = await Catalog.createProduct(
      product({
        name: `Fish ${tag}`,
        baseUnitId: kg,
        stockQuantity: 100.5,
        taxRate: 0,
        packagings: [
          {
            unitId: crate,
            qtyPerBase: '20',
            weightKg: '',
            isSalesDefault: false,
            isPurchaseDefault: false,
          },
        ],
      }),
    );
    fishId = fish.id;
    phoneId = (
      await Catalog.createProduct(
        product({ name: `Phone ${tag}`, baseUnitId: pcs, stockQuantity: 10 }),
      )
    ).id;
  });

  describe('stock in decimals', () => {
    it('keeps 100.5 kg exactly, with the unit on the product', async () => {
      const row = await Catalog.getProductById(fishId);
      expect(row).toMatchObject({ stockQuantity: 100.5, baseUnitCode: 'KG', baseUnitDecimals: 3 });
      expect((await stockOf(fishId))?.stockQuantity).toBe(100.5);
    });

    it('adjusts, receives and writes off in decimals without drift, and journals each change', async () => {
      const { InventoryDomainService: Inventory } =
        await import('@/server/domains/inventory/service');
      await Inventory.adjust(fishId, 12.345);
      expect((await stockOf(fishId))?.stockQuantity).toBe(12.345);
      await Inventory.receive(fishId, 0.1, 'Supplier', 'PO-1');
      await Inventory.receive(fishId, 0.2, 'Supplier', 'PO-2');
      expect((await stockOf(fishId))?.stockQuantity).toBe(12.645);
      await Inventory.writeOff(fishId, 0.645, 'damage_transit');
      expect((await stockOf(fishId))?.stockQuantity).toBe(12);
      const ledger = (
        await db
          .select()
          .from(schema.inventoryMovements)
          .where(eq(schema.inventoryMovements.productId, fishId))
      ).map((m) => m.changeAmount);
      expect(ledger).toEqual(expect.arrayContaining([-0.645, 0.2, 0.1]));
    });

    it('refuses more decimals than the unit allows, with words', async () => {
      const { InventoryDomainService: Inventory } =
        await import('@/server/domains/inventory/service');
      await expect(Inventory.adjust(fishId, 1.2345)).rejects.toThrow(/at most 3 decimals/);
      await expect(Inventory.adjust(phoneId, 2.5)).rejects.toThrow(/must be a whole number/);
      await expect(
        Catalog.createProduct(product({ baseUnitId: pcs, stockQuantity: 1.5 })),
      ).rejects.toThrow(/whole number/);
      await expect(Catalog.updateProduct(phoneId, { stockQuantity: 3.5 })).rejects.toThrow(
        /whole number/,
      );
      expect((await stockOf(phoneId))?.stockQuantity).toBe(10);
    });

    it('reserves, fulfils and releases fractions, and refuses a fraction of a piece', async () => {
      const { OrderWriteService } = await import('@/server/domains/orders/write-service');
      const { InventoryReservationService: Reservation } =
        await import('@/server/domains/inventory/reservation-service');
      const place = (productId: string, quantity: number, over: Record<string, unknown> = {}) =>
        OrderWriteService.createOrder({
          branchId,
          orderNumber: `DU-${randomUUID()}`,
          customerName: 'Buyer',
          customerEmail: `b-${tag}@t.test`,
          customerPhone: '0700000000',
          shippingAddress: { street: '1', city: 'N', countyOrState: 'N', country: 'KE' },
          items: [{ productId, quantity }],
          currency: 'KES',
          paymentMethod: 'mpesa_daraja',
          ...over,
        });
      const refused = await place(phoneId, 1.5);
      expect(refused).toMatchObject({ success: false });
      expect(refused.error).toMatch(/whole number/);
      const before = (await stockOf(fishId))?.reservedQuantity ?? 0;
      const placed = await place(fishId, 2.25);
      expect(placed.success).toBe(true);
      expect((await stockOf(fishId))?.reservedQuantity).toBe(before + 2.25);
      expect(placed.order?.items[0]).toMatchObject({
        quantity: 2.25,
        unitCode: 'KG',
        enteredQuantity: null,
      });
      await Reservation.releaseOrder(placed.order?.id ?? '', 'test');
      expect((await stockOf(fishId))?.reservedQuantity).toBe(before);
      expect((await stockOf(fishId))?.stockQuantity).toBe(12);
    });
  });

  describe('a quote line typed in a unit of the product', () => {
    const quoteOf = (lines: Record<string, unknown>[]) =>
      ({
        customerName: 'Buyer',
        currency: 'KES',
        paymentMethod: 'mpesa_daraja',
        discountPercent: 0,
        shippingFee: 0,
        sections: [],
        deliveryAddress: { street: '1', city: 'N', countyOrState: 'N', country: 'KE' },
        lines,
      }) as never;
    const crateLine = (over: Record<string, unknown> = {}) => ({
      productId: fishId,
      quantity: 3,
      unitId: crate,
      unitPrice: 1500,
      priceMode: 'manual',
      discountPercent: 0,
      ...over,
    });

    it('is worked out in kilograms, keeps what was typed, and prices it exactly', async () => {
      const { SalesQuoteService } = await import('@/server/domains/quotes/service');
      const quote = await new SalesQuoteService().create(userId, quoteOf([crateLine()]));
      const line = quote.lines[0];
      expect(Number(line?.quantity)).toBe(60);
      expect(line).toMatchObject({ unitId: crate, enteredQuantity: 3 });
      expect(Number(line?.qtyPerUnit)).toBe(20);
      expect(line?.unitCode).toBe(`${tag}CR`);
      expect(Number(line?.enteredUnitPrice)).toBe(1500);
      expect(Number(line?.lineAmount)).toBe(4500);
      expect(Number(quote.totalAmount)).toBe(4500);
      expect(Number(line?.costAmount)).toBe(3000);
    });

    it('is not priced through a rounded price per kilogram: 1000 per crate of 12 stays 1000', async () => {
      const { SalesQuoteService } = await import('@/server/domains/quotes/service');
      const dozen = await c.unitWriter.create({
        ...emptyUnitDraft(),
        kind: 'packaging',
        code: `${tag}DZ`,
        name: `DZ ${tag}`,
        decimals: '0',
      });
      const sold = await Catalog.createProduct(
        product({
          name: `Sold ${tag}`,
          baseUnitId: pcs,
          stockQuantity: 5000,
          packagings: [
            {
              unitId: dozen.id,
              qtyPerBase: '12',
              weightKg: '',
              isSalesDefault: false,
              isPurchaseDefault: false,
            },
          ],
        }),
      );
      const quote = await new SalesQuoteService().create(
        userId,
        quoteOf([
          {
            productId: sold.id,
            quantity: 100,
            unitId: dozen.id,
            unitPrice: 1000,
            priceMode: 'manual',
            discountPercent: 0,
          },
        ]),
      );
      expect(Number(quote.lines[0]?.quantity)).toBe(1200);
      expect(Number(quote.lines[0]?.lineAmount)).toBe(100000);
    });

    it('gives the same totals while it is typed (the preview)', async () => {
      const { QuoteFormService } = await import('@/server/domains/quotes/quote-form-service');
      const totals = await new QuoteFormService().previewTotals({
        lines: [
          { productId: fishId, quantity: 3, unitId: crate, unitPrice: 1500, discountPercent: 0 },
        ],
        discountPercent: 0,
        shippingFee: 0,
      });
      expect(totals.total).toBe(4500);
      expect(totals.cost).toBe(3000);
    });

    it('comes back to the editor as it was typed, and saves again unchanged', async () => {
      const { SalesQuoteService } = await import('@/server/domains/quotes/service');
      const { quoteFormOf } = await import('@/server/domains/quotes/quote-forms');
      const quotes = new SalesQuoteService();
      const first = await quotes.create(userId, quoteOf([crateLine({ quantity: 2 })]));
      const form = quoteFormOf(first, randomUUID);
      expect(form.lines[0]).toMatchObject({
        quantity: 2,
        unitId: crate,
        unitPrice: 1500,
        unitCode: `${tag}CR`,
      });
      const again = await quotes.update(userId, first.id, form);
      expect(Number(again.lines[0]?.quantity)).toBe(40);
      expect(again.lines[0]).toMatchObject({ enteredQuantity: 2 });
      expect(Number(again.totalAmount)).toBe(3000);
    });

    it('refuses a unit the product is not sold in, and a quantity that does not fit', async () => {
      const { SalesQuoteService } = await import('@/server/domains/quotes/service');
      const quotes = new SalesQuoteService();
      await expect(
        quotes.create(userId, quoteOf([crateLine({ unitId: otherPack })])),
      ).rejects.toThrow(/not sold in that unit/);
      await expect(
        quotes.create(
          userId,
          quoteOf([
            {
              productId: phoneId,
              quantity: 1.5,
              discountPercent: 0,
              unitPrice: 10,
              priceMode: 'manual',
            },
          ]),
        ),
      ).rejects.toThrow(/whole number/);
    });

    it('counts as use of the unit, so it cannot be deleted while a quote uses it', async () => {
      const usage = (await c.units.usageOf([crate]))[crate];
      expect(usage?.documentLines).toBeGreaterThan(0);
      await expect(c.unitWriter.remove(crate)).rejects.toThrow(/quote and order lines?/);
    });

    it('carries the unit to the order made from it, and shows it on the invoice', async () => {
      const { OrderWriteService } = await import('@/server/domains/orders/write-service');
      const { InventoryDomainService: Inventory } =
        await import('@/server/domains/inventory/service');
      await Inventory.adjust(fishId, 200);
      const res = await OrderWriteService.createOrder({
        branchId,
        orderNumber: `DU-${randomUUID()}`,
        customerName: 'Buyer',
        customerEmail: `q-${tag}@t.test`,
        customerPhone: '0700000000',
        shippingAddress: { street: '1', city: 'N', countyOrState: 'N', country: 'KE' },
        items: [{ productId: fishId, quantity: 60 }],
        quotedItems: [
          {
            productId: fishId,
            quantity: 60,
            productName: 'Fish',
            sku: 'F',
            lineAmount: 4500,
            taxRate: 0,
            isTaxInclusive: true,
            unitId: crate,
            unitCode: 'CRATE',
            enteredQuantity: 3,
            qtyPerUnit: '20',
            enteredUnitPrice: 1500,
          },
        ],
        quotedTotals: { subtotal: 4500, tax: 0, shippingFee: 0, totalAmount: 4500 },
        currency: 'KES',
        paymentMethod: 'mpesa_daraja',
        salesModule: 'sales_order',
      });
      expect(res.error).toBeUndefined();
      expect(res.success).toBe(true);
      const saved = await c.orders.getById(res.order?.id ?? '');
      expect(saved?.items[0]).toMatchObject({
        quantity: 60,
        unitId: crate,
        unitCode: 'CRATE',
        enteredQuantity: 3,
        enteredUnitPrice: 1500,
        totalPrice: 4500,
      });
      expect(Number(saved?.items[0]?.qtyPerUnit)).toBe(20);
      const { quantityWords } = await import('@/lib/unit-rules');
      const item = saved?.items[0];
      if (item === undefined) throw new Error('the order has no line');
      expect(
        quantityWords({
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          total: item.totalPrice,
          unitCode: item.unitCode,
          enteredQuantity: item.enteredQuantity,
          enteredUnitPrice: item.enteredUnitPrice,
        }),
      ).toBe('3 CRATE');
    });
  });

  describe('conversions for the screens that only need the factor', () => {
    it('gives 1 for the base unit, what the unit holds for an alternate unit, and refuses one the product is not sold in', async () => {
      const base = (id: string) => (id === fishId ? kg : undefined);
      expect(
        await c.unitWriter.lineFactors(
          [
            { productId: fishId },
            { productId: fishId, unitId: kg },
            { productId: fishId, unitId: crate },
          ],
          base,
        ),
      ).toEqual([1, 1, 20]);
      await expect(
        c.unitWriter.lineFactors([{ productId: fishId, unitId: otherPack }], base),
      ).rejects.toThrow(/not sold in/);
    });
  });

  describe('the product list of units for a line', () => {
    it('offers the base unit first and the alternate units, only for that product', async () => {
      const { getLookupSource } = await import('@/server/domains/lookups/sources');
      const source = getLookupSource('product-units');
      const page = await source?.search({
        companyId: 'x',
        query: '',
        limit: 20,
        after: null,
        filters: { product: fishId },
      });
      expect(page?.options.map((o) => o.meta?.code)).toEqual(
        expect.arrayContaining(['KG', `${tag}CR`]),
      );
      expect(page?.options.find((o) => o.meta?.code === `${tag}CR`)?.meta?.qtyPerUnit).toBe('20');
      await expect(
        source?.search({ companyId: 'x', query: '', limit: 20, after: null, filters: {} }),
      ).rejects.toThrow();
      await expect(
        source?.search({
          companyId: 'x',
          query: '',
          limit: 20,
          after: null,
          filters: { product: 'nope' },
        }),
      ).rejects.toThrow();
    });
  });
});
