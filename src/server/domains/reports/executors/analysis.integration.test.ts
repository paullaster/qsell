import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type * as ClientModule from '@/server/db/drizzle/client';
import type * as SchemaModule from '@/server/db/drizzle/schema';
import type { PermissionKey } from '@/server/domains/access-control/permissions';
import type { RegisteredExecutor } from '../engine/run';
import type { AnalysisReport } from '../analysis/types';
import { tableProblems } from '../export/table';
import { has } from '@/lib/values';

/**
 * The sales, stock and collections reports against a real database built from the migrations:
 *   TEST_DATABASE_URL=postgres://... pnpm test
 * Everything is attached to a branch made here (the viewer is pinned to it), so other data in a shared database never
 * changes the expected numbers. Stock reports read the whole company, so they are checked by what they must contain.
 */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

describe.skipIf(!has(url))('sales, stock and collections reports (database)', () => {
  let db: typeof ClientModule.drizzleDb;
  let executors: RegisteredExecutor[];
  let branchId: string;
  let userId: string;
  const tag = randomUUID().slice(0, 6);
  const NOW = new Date('2026-03-10T18:00:00Z');
  const at = (hhmm: string, date = '2026-03-10') => new Date(`${date}T${hhmm}:00+03:00`);
  const day = { period: 'custom', from: '2026-03-10', to: '2026-03-10' };

  const WITH_COST: ReadonlySet<PermissionKey> = new Set<PermissionKey>(['report_profit:read']);
  const WITHOUT_COST: ReadonlySet<PermissionKey> = new Set<PermissionKey>();

  const run = async (
    code: string,
    raw: Record<string, string> = day,
    allowed: ReadonlySet<PermissionKey> = WITH_COST,
  ): Promise<AnalysisReport> => {
    const executor = executors.find((e) => e.code === code);
    if (executor === undefined) throw new Error(`no executor ${code}`);
    const prepared = executor.prepare(raw);
    if (!prepared.ok) throw new Error(prepared.error);
    const result = await prepared.run.execute({
      userId,
      allowed,
      now: NOW,
      maxRows: 500,
      wantTable: true,
    });
    return result.data as AnalysisReport;
  };
  const labels = (r: AnalysisReport): string[] => r.table.rows.map((row) => String(row[0]));
  const col = (r: AnalysisReport, label: string): number =>
    r.table.columns.findIndex((c) => c.label === label);
  const cell = (r: AnalysisReport, rowLabel: string, column: string): unknown =>
    r.table.rows.find((row) => row[0] === rowLabel)?.[col(r, column)];

  beforeAll(async () => {
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    const schema: typeof SchemaModule = await import('@/server/db/drizzle/schema');
    const container = (await import('@/server/di/container')).getContainer();
    const companyId = (await container.companySettings.ensureSeeded()).id;
    await db
      .insert(schema.currencies)
      .values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true })
      .onConflictDoNothing();
    const [b] = await db
      .insert(schema.branches)
      .values({ companyId, code: `A${tag}`, name: 'A Branch' })
      .returning();
    branchId = b?.id ?? '';
    const [u] = await db
      .insert(schema.users)
      .values({
        email: `a-${randomUUID()}@rpt.test`,
        passwordHash: 'x',
        name: 'A',
        role: 'manager',
        branchId,
      })
      .returning();
    userId = u?.id ?? '';

    const itemTypeId = `it_a_${tag}`;
    await db
      .insert(schema.itemTypes)
      .values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    await db
      .insert(schema.categories)
      .values({ id: `cat_a_${tag}`, name: 'Groceries A', slug: `groceries-a-${tag}` });
    const product = async (
      key: string,
      name: string,
      over: Partial<typeof schema.products.$inferInsert>,
    ) => {
      await db.insert(schema.products).values({
        id: `prod_a_${key}_${tag}`,
        sku: `SKU-${key}-${tag}`,
        stockCode: `SC-${key}-${tag}`.toUpperCase(),
        name,
        slug: `slug-${key}-${tag}`,
        itemTypeId,
        categoryId: `cat_a_${tag}`,
        categoryName: 'Groceries A',
        costPrice: '10',
        ...over,
      });
    };
    await product('soap', `Soap ${tag}`, {
      stockQuantity: 3,
      lowStockThreshold: 5,
      costPrice: '50',
    });
    await product('milk', `Milk ${tag}`, {
      stockQuantity: 0,
      lowStockThreshold: 2,
      costPrice: '20',
    });
    await product('flour', `Flour ${tag}`, {
      stockQuantity: 40,
      lowStockThreshold: 5,
      costPrice: '10',
    });
    await product('svc', `Service ${tag}`, {
      inventoryKind: 'service',
      stockQuantity: 0,
      lowStockThreshold: 0,
    });

    const order = async (
      over: Partial<typeof schema.orders.$inferInsert>,
      items: { key: string; name: string; qty: number; total: string; cost: string | null }[],
    ) => {
      const id = `ord_${randomUUID()}`;
      await db.insert(schema.orders).values({
        id,
        orderNumber: `A-${randomUUID().slice(0, 12)}`,
        branchId,
        customerName: 'A',
        customerEmail: '',
        customerPhone: '',
        shippingAddress: { street: 's', city: 'c', countyOrState: 'k', country: 'KE' },
        subtotal: '0',
        tax: '0',
        shippingFee: '0',
        totalAmount: '0',
        paymentMethod: 'mpesa_daraja',
        paymentStatus: 'paid',
        status: 'processing',
        createdAt: at('10:00'),
        ...over,
      });
      for (const [i, it] of items.entries()) {
        await db.insert(schema.orderItems).values({
          orderId: id,
          productId: `prod_a_${it.key}_${tag}`,
          productName: it.name,
          sku: `S${String(i)}`,
          quantity: it.qty,
          unitPrice: String(Number(it.total) / it.qty),
          totalPrice: it.total,
          unitCost: it.cost,
          isGift: false,
        });
      }
    };
    const soap = { key: 'soap', name: `Soap ${tag}` };
    const milk = { key: 'milk', name: `Milk ${tag}` };
    await order(
      {
        customerName: 'Amina',
        customerPhone: '0711',
        subtotal: '500',
        tax: '80',
        shippingFee: '20',
        totalAmount: '600',
      },
      [
        { ...soap, qty: 3, total: '300', cost: '50' },
        { ...milk, qty: 2, total: '200', cost: null },
      ],
    );
    await order(
      {
        customerName: 'Amina',
        customerPhone: '0711',
        createdAt: at('09:00', '2026-03-01'),
        subtotal: '50',
        totalAmount: '50',
      },
      [{ ...soap, qty: 1, total: '50', cost: '25' }],
    );
    await order(
      {
        customerName: 'Chege',
        customerPhone: '0722',
        createdAt: at('14:30'),
        subtotal: '100',
        tax: '16',
        totalAmount: '116',
      },
      [{ ...soap, qty: 1, total: '100', cost: '50' }],
    );
    await order({ customerName: '', createdAt: at('14:45'), subtotal: '50', totalAmount: '50' }, [
      { ...milk, qty: 1, total: '50', cost: '20' },
    ]);

    const { salesExecutors } = await import('./sales');
    const { inventoryExecutors } = await import('./inventory');
    const { collectionsExecutors } = await import('./collections');
    executors = [
      ...salesExecutors({ db }),
      ...inventoryExecutors({ db }),
      ...collectionsExecutors({ db }),
    ];
  });

  describe('sales reports', () => {
    it('ranks products and adds up to the overview through tax and delivery', async () => {
      const r = await run('sales-by-product');
      expect(labels(r)).toEqual([`Soap ${tag}`, `Milk ${tag}`]);
      expect(cell(r, `Soap ${tag}`, 'Units')).toBe(4);
      expect(cell(r, `Soap ${tag}`, 'Sales (KES)')).toBe(400);
      expect(r.reconciliation.map((l) => l.value)).toEqual([650, 0, 96, 20, 766]);
      expect(r.reconciliation.slice(0, 4).reduce((a, l) => a + l.value, 0)).toBe(766);
      expect(r.rowLinks[0]).toBe(`/admin/products/prod_a_soap_${tag}`);
    });

    it('shows cost and margin only to someone who may see cost', async () => {
      const withCost = await run('sales-by-product', day, WITH_COST);
      expect(withCost.table.columns.map((c) => c.label)).toContain('Margin %');
      expect(cell(withCost, `Soap ${tag}`, 'Margin (KES)')).toBe(200);
      const without = await run('sales-by-product', day, WITHOUT_COST);
      expect(without.table.columns.map((c) => c.label)).not.toContain('Margin %');
      expect(without.table.columns.map((c) => c.label)).not.toContain('Cost (KES)');
      expect(without.kpis.map((k) => k.key)).not.toContain('margin');
    });

    it('leaves a line with no cost out of the margin instead of treating it as free', async () => {
      const r = await run('gross-margin');
      // Milk: one line without a cost (200) and one with a cost of 20 against 50.
      expect(cell(r, `Milk ${tag}`, 'Cost (KES)')).toBe(20);
      expect(cell(r, `Milk ${tag}`, 'Margin (KES)')).toBe(30);
    });

    it('groups products by the category they are in, and puts the rest apart', async () => {
      const r = await run('sales-by-category');
      expect(labels(r)).toEqual(['Groceries A']);
      expect(cell(r, 'Groceries A', 'Sales (KES)')).toBe(650);
      const v = await run('sales-by-vendor');
      expect(labels(v)).toEqual(['No supplier on record']);
    });

    it('matches the overview exactly when whole orders are added up by branch', async () => {
      const r = await run('sales-by-branch');
      expect(labels(r)).toEqual(['A Branch']);
      expect(cell(r, 'A Branch', 'Sales (KES)')).toBe(766);
      expect(r.table.totals?.[col(r, 'Sales (KES)')]).toBe(766);
    });

    it('lists customers, with the unnamed together', async () => {
      const r = await run('sales-by-customer');
      expect(labels(r)).toEqual(['Amina', 'Chege', 'Walk-in customer']);
      expect(cell(r, 'Amina', 'Sales (KES)')).toBe(600);
    });

    it('lines each day up with its counterpart, and finds the busy hours', async () => {
      const summary = await run('sales-summary');
      expect(summary.table.rows).toHaveLength(1);
      expect(summary.kpis.find((k) => k.key === 'sales')?.value).toBe(766);
      const hours = await run('sales-by-hour');
      expect(hours.table.rows).toHaveLength(24);
      expect(cell(hours, '10:00', 'Orders')).toBe(1);
      expect(cell(hours, '14:00', 'Orders')).toBe(2);
      const weekdays = await run('sales-by-weekday');
      expect(cell(weekdays, 'Tuesday', 'Orders')).toBe(3);
    });

    it('tells new from returning customers', async () => {
      const r = await run('returning-customers');
      expect(cell(r, 'Returning customers', 'Customers or orders')).toBe(1);
      expect(cell(r, 'New customers', 'Customers or orders')).toBe(1);
      expect(r.kpis.find((k) => k.key === 'rate')?.value).toBe(50);
    });

    it('reads returns when there are none', async () => {
      const r = await run('sales-returns');
      expect(r.table.rows).toEqual([]);
    });

    it('returns an empty report, never every branch, for a person with no branch', async () => {
      const executor = executors.find((e) => e.code === 'sales-by-branch');
      const prepared = executor?.prepare(day);
      if (prepared === undefined) throw new Error('no executor');
      if (!prepared.ok) throw new Error(prepared.error);
      const result = await prepared.run.execute({
        userId: randomUUID(),
        allowed: WITH_COST,
        now: NOW,
        maxRows: 500,
        wantTable: false,
      });
      expect((result.data as AnalysisReport).table.rows).toEqual([]);
    });
  });

  describe('every report is a valid table', () => {
    const codes = [
      'sales-summary',
      'sales-by-product',
      'sales-by-category',
      'sales-by-vendor',
      'sales-by-branch',
      'sales-by-customer',
      'sales-by-weekday',
      'sales-by-hour',
      'returning-customers',
      'sales-returns',
      'gross-margin',
      'money-collected',
      'stock-valuation',
      'low-stock',
      'slow-stock',
      'stock-movement',
    ];
    for (const code of codes) {
      it(`${code} has rows that fit its columns, a link or null for every row, and says what it counts`, async () => {
        const r = await run(code);
        expect(tableProblems(r.table)).toEqual([]);
        expect(r.rowLinks).toHaveLength(r.table.rows.length);
        expect(r.notes.length).toBeGreaterThan(0);
        expect(r.facts.baseCurrency).toBe('KES');
      });
    }
  });

  describe('stock reports', () => {
    it('lists a product at or below its reorder level and one with nothing, but never a service', async () => {
      const r = await run('low-stock');
      const names = labels(r);
      expect(names).toContain(`Soap ${tag}`);
      expect(names).toContain(`Milk ${tag}`);
      expect(names).not.toContain(`Flour ${tag}`);
      expect(names).not.toContain(`Service ${tag}`);
      expect(cell(r, `Milk ${tag}`, 'Status')).toBe('Out of stock');
      expect(cell(r, `Soap ${tag}`, 'Status')).toBe('Low');
      // Out of stock comes before low.
      expect(names.indexOf(`Milk ${tag}`)).toBeLessThan(names.indexOf(`Soap ${tag}`));
      expect(r.facts.asAtNow).toBe(true);
    });

    it('works out days of cover from the last 30 days of sales', async () => {
      const r = await run('low-stock');
      // Soap: 3 available, 5 units sold in 30 days (4 on the day plus 1 earlier) = 3 / (5 / 30) = 18 days.
      expect(cell(r, `Soap ${tag}`, 'Days of cover')).toBe(18);
    });

    it('calls stock that has never sold dead, with the cash tied up in it', async () => {
      const r = await run('slow-stock');
      expect(labels(r)).toContain(`Flour ${tag}`);
      expect(labels(r)).not.toContain(`Soap ${tag}`);
      expect(cell(r, `Flour ${tag}`, 'Cash tied up (KES)')).toBe(400);
      expect(cell(r, `Flour ${tag}`, 'Last sold')).toBe('Never');
    });

    it('proves the valuation list against the stock value on the overview', async () => {
      const r = await run('stock-valuation');
      const [listed, missing, overview] = r.reconciliation.map((l) => l.value);
      expect(Math.round(((listed ?? 0) + (missing ?? 0)) * 100)).toBe(
        Math.round((overview ?? 0) * 100),
      );
      expect(cell(r, `Flour ${tag}`, 'Stock value (KES)')).toBe(400);
      expect(labels(r)).not.toContain(`Service ${tag}`);
    });
  });
});
