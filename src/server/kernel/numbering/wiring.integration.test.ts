import { beforeAll, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';

/**
 * The app's own flows number their documents from the series. Run against a throwaway database:
 *   TEST_DATABASE_URL=postgres://... pnpm test
 * (DATABASE_URL is pointed at it before the container loads.)
 */
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;

describe.skipIf(!url)('flows use the number series', () => {
  let container: ReturnType<typeof import('@/server/di/container').getContainer>;
  let companyId: string;
  let schema: typeof import('@/server/db/drizzle/schema');

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    schema = await import('@/server/db/drizzle/schema');
    container = mod.getContainer();
    companyId = (await container.companySettings.ensureSeeded()).id;
  });

  it('numbers simultaneous customers uniquely', async () => {
    const make = (i: number) =>
      container.customers.saveCustomer(companyId, {
        name: `Wiring Customer ${i}`,
        email: `wiring-${Date.now()}-${i}@example.com`,
        accountType: 'cash',
        creditLimit: 0,
        paymentTermDays: 0,
        transmitInvoicesToKra: true,
      } as never);
    const rows = await Promise.all(Array.from({ length: 12 }, (_, i) => make(i)));
    const numbers = rows.map((r) => r.number);
    expect(new Set(numbers).size).toBe(12);
  });

  it('numbers stock adjustments, one reference per batch', async () => {
    const { InventoryDomainService: InventoryService } =
      await import('@/server/domains/inventory/service');
    const db = (await import('@/server/db/drizzle/client')).drizzleDb;
    const [p] = await db.select().from(schema.products).limit(1);
    if (!p) return; // no products in this database
    await InventoryService.adjust(p.id, p.stockQuantity);
    await InventoryService.adjust(p.id, p.stockQuantity);
    // The two references just made: different from each other, and numbered.
    const moves = await db
      .select({ ref: schema.inventoryMovements.referenceId })
      .from(schema.inventoryMovements)
      .where(eq(schema.inventoryMovements.productId, p.id))
      .orderBy(desc(schema.inventoryMovements.createdAt))
      .limit(2);
    const refs = moves.map((m) => m.ref!);
    expect(new Set(refs).size).toBe(2);
    expect(refs.every((r) => /^ADJ.*\d{6,}/.test(r))).toBe(true);
  });
});
