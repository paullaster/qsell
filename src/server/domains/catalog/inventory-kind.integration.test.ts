import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { drizzleDb as Db } from '@/server/db/drizzle/client';
import type * as Schema from '@/server/db/drizzle/schema';
import type { CatalogService as CatalogServiceType } from './service';
import type { ProductWrite } from '@/types/index';
import { has } from '@/lib/values';

const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

describe.skipIf(!has(url))('operational inventory kind (database)', () => {
  let db: typeof Db;
  let schema: typeof Schema;
  let CatalogService: typeof CatalogServiceType;
  let itemTypeId: string;
  const token = randomUUID().slice(0, 10).toUpperCase();

  const product = (name: string, over: Partial<ProductWrite> = {}): ProductWrite => ({
    sku: `${token}-${name.slice(0, 5)}`,
    stockCode: `${token}-S-${name.slice(0, 5)}`,
    name: `${name} ${token}`,
    slug: `${name.toLowerCase().replaceAll(' ', '-')}-${token.toLowerCase()}`,
    description: '',
    category: '',
    itemTypeId,
    itemTypeName: '',
    itemTypeCode: 1,
    isSellable: true,
    price: 20,
    costPrice: 5,
    stockQuantity: 0,
    lowStockThreshold: 0,
    isActive: true,
    imageUrl: '',
    rating: 0,
    reviewCount: 0,
    tags: [],
    inventoryKind: 'inventory',
    ...over,
  });

  beforeAll(async () => {
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    ({ CatalogService } = await import('./service'));
    itemTypeId = `it_kind_${token}`;
    await db.insert(schema.itemTypes).values({
      id: itemTypeId,
      code: Math.floor(Math.random() * 1e9),
      name: itemTypeId,
      isSellable: true,
    });
  });

  it('defaults existing callers to Inventory and creates service/non-inventory products without stock movements', async () => {
    const legacy = await CatalogService.createProduct(
      product('Legacy inventory', { inventoryKind: undefined }),
    );
    const service = await CatalogService.createProduct(
      product('Consulting', { inventoryKind: 'service' }),
    );
    const nonInventory = await CatalogService.createProduct(
      product('Office supplies', { inventoryKind: 'non_inventory' }),
    );

    expect(legacy.inventoryKind).toBe('inventory');
    expect(service).toMatchObject({ inventoryKind: 'service', isSellable: true, stockQuantity: 0 });
    expect(nonInventory).toMatchObject({
      inventoryKind: 'non_inventory',
      isSellable: true,
      stockQuantity: 0,
    });
    const nonStockMovements = await db
      .select({ productId: schema.inventoryMovements.productId })
      .from(schema.inventoryMovements)
      .where(
        and(
          eq(schema.inventoryMovements.productId, service.id),
          eq(schema.inventoryMovements.changeType, 'restock'),
        ),
      );
    expect(nonStockMovements).toEqual([]);

    await expect(
      CatalogService.createProduct(
        product('Bad service stock', { inventoryKind: 'service', stockQuantity: 1 }),
      ),
    ).rejects.toThrow(/cannot have on-hand or reserved stock/);
    await expect(
      CatalogService.createProduct(
        product('Bad reorder threshold', { inventoryKind: 'non_inventory', lowStockThreshold: 2 }),
      ),
    ).rejects.toThrow(/reorder threshold/);
    const reclassified = await CatalogService.updateProduct(service.id, {
      inventoryKind: 'non_inventory',
    });
    expect(reclassified.inventoryKind).toBe('non_inventory');
    await db.insert(schema.inventoryMovements).values({
      id: `ledger_${randomUUID()}`,
      productId: service.id,
      productName: service.name,
      changeAmount: 1,
      previousStock: 0,
      newStock: 1,
      changeType: 'restock',
      referenceId: `INV-${randomUUID()}`,
      actor: 'integration-test',
      note: 'stock history blocker',
    });
    await expect(
      CatalogService.updateProduct(service.id, { inventoryKind: 'inventory' }),
    ).rejects.toThrow(/stock or document history/);
    await expect(
      db
        .update(schema.products)
        .set({ inventoryKind: 'inventory' })
        .where(eq(schema.products.id, service.id)),
      // The driver reports a failed statement as "Failed query"; what the trigger said is the cause.
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/stock or document history/) as string } });

    const { StockLedger } = await import('@/server/domains/stock/ledger');
    const ledger = new StockLedger(db);
    await expect(
      db.transaction((tx) =>
        ledger.post(tx, {
          companyId: randomUUID(),
          productId: service.id,
          locationId: randomUUID(),
          type: 'receipt',
          quantity: 1,
          actor: { type: 'job' },
        }),
      ),
    ).rejects.toThrow(/only be posted for inventory-managed products/);

    const { getContainer } = await import('@/server/di/container');
    const company = await getContainer().companySettings.ensureSeeded();
    const reservation = await getContainer().stockReservations.reserve({
      companyId: company.id,
      refType: 'integration_test',
      refId: randomUUID(),
      lines: [{ productId: nonInventory.id, quantity: 1 }],
      channel: 'ecommerce',
      actor: 'integration-test',
    });
    expect(reservation).toMatchObject({
      ok: false,
      productId: nonInventory.id,
    });
    expect(reservation.ok ? '' : reservation.error).toMatch(/not inventory-managed/);
  });
});
