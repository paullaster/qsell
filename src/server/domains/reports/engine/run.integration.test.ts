import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type * as ClientModule from '@/server/db/drizzle/client';
import type * as SchemaModule from '@/server/db/drizzle/schema';
import type * as ServiceModule from '../service';
import type * as RunModule from './run';
import type * as OverviewModule from '../executors/overview';
import type { BusinessOverview } from '../types';
import { has, required } from '@/lib/values';

/**
 * The golden test of work package 3: the Business Overview produced through the report runner must equal, to the
 * last field, what the overview service has always produced. Runs against a real database built from the migrations:
 *   TEST_DATABASE_URL=postgres://... pnpm test
 * Everything is attached to a branch made here and a fixed historical day, so other data in a shared database
 * cannot change the expected numbers.
 */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

describe.skipIf(!has(url))('report runner: business overview (database)', () => {
  let db: typeof ClientModule.drizzleDb;
  let schema: typeof SchemaModule;
  let ReportsService: typeof ServiceModule.ReportsService;
  let ReportRunner: typeof RunModule.ReportRunner;
  let registerExecutor: typeof RunModule.registerExecutor;
  let overviewExecutor: typeof OverviewModule.overviewExecutor;
  let branchId: string;
  let branchUserId: string;
  let noBranchUserId: string;

  const NOW = new Date('2026-03-10T18:00:00Z');
  const at = (hhmm: string, day = '2026-03-10') => new Date(`${day}T${hhmm}:00+03:00`);
  const range = { preset: 'custom', from: '2026-03-10', to: '2026-03-10' };

  const ALL = [
    'dashboard:read',
    'report_sales:read',
    'report_collections:read',
    'report_profit:read',
    'report_receivables:read',
    'report_inventory:read',
    'reports:all_branches',
    'orders:read',
    'approvals:act',
    'transactions:read',
  ];
  const PINNED = ALL.filter((k) => k !== 'reports:all_branches');
  const accessFor = (allowed: string[]) => ({
    can: (_user: string, key: string) => Promise.resolve(allowed.includes(key)),
  });

  /** A service and a runner with their own caches, so one answer never comes from the other's cache. */
  const build = (allowed: string[]) => {
    const access = accessFor(allowed) as never;
    const service = new ReportsService(db, access, () => NOW);
    const runner = new ReportRunner({
      access,
      executors: [registerExecutor(overviewExecutor(service))],
      clock: () => NOW,
    });
    return { service, runner };
  };

  beforeAll(async () => {
    ({ drizzleDb: db } = await import('@/server/db/drizzle/client'));
    schema = await import('@/server/db/drizzle/schema');
    ({ ReportsService } = await import('../service'));
    ({ ReportRunner, registerExecutor } = await import('./run'));
    ({ overviewExecutor } = await import('../executors/overview'));

    const container = (await import('@/server/di/container')).getContainer();
    const companyId = (await container.companySettings.ensureSeeded()).id;
    await db
      .insert(schema.currencies)
      .values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true })
      .onConflictDoNothing();
    const [branch] = await db
      .insert(schema.branches)
      .values({ companyId, code: `R${randomUUID().slice(0, 6)}`, name: 'Runner Branch' })
      .returning();
    branchId = required(branch, 'the branch').id;
    const mkUser = async (branch: string | null) => {
      const [row] = await db
        .insert(schema.users)
        .values({
          email: `run-${randomUUID()}@rpt.test`,
          passwordHash: 'x',
          name: 'R',
          role: 'manager',
          branchId: branch,
        })
        .returning();
      return required(row, 'the user').id;
    };
    branchUserId = await mkUser(branchId);
    noBranchUserId = await mkUser(null);

    const orderId = `ord_${randomUUID()}`;
    await db.insert(schema.orders).values({
      id: orderId,
      orderNumber: `RUN-${randomUUID().slice(0, 12)}`,
      branchId,
      customerName: 'Runner',
      customerEmail: 'runner@test.local',
      customerPhone: '0',
      shippingAddress: { street: 's', city: 'c', countyOrState: 'k', country: 'KE' },
      subtotal: '0',
      tax: '16',
      shippingFee: '0',
      totalAmount: '116',
      paymentMethod: 'mpesa_daraja',
      paymentStatus: 'paid',
      status: 'processing',
      createdAt: at('10:00'),
    });
    await db.insert(schema.orderItems).values({
      orderId,
      productId: `prod_runner_${randomUUID().slice(0, 8)}`,
      productName: 'Runner widget',
      sku: 'RUN1',
      quantity: 2,
      unitPrice: '50',
      totalPrice: '100',
      unitCost: '30',
      isGift: false,
    });
  });

  const same = async (allowed: string[], userId: string, params: Record<string, unknown>) => {
    const direct = await build(allowed).service.getBusinessOverview(userId, params);
    const viaRunner = await build(allowed).runner.run('business-overview', params, userId);
    expect(viaRunner.ok).toBe(true);
    if (!viaRunner.ok) return;
    expect(viaRunner.data).toEqual(direct);
  };

  it('returns exactly the service result for a branch-pinned viewer', async () => {
    await same(PINNED, branchUserId, range);
  });

  it('returns exactly the service result for a viewer of every branch', async () => {
    await same(ALL, branchUserId, { ...range, branchId });
    await same(ALL, branchUserId, range);
  });

  it('returns exactly the service result for other periods and comparisons', async () => {
    await same(PINNED, branchUserId, { preset: 'this_month', compare: 'previous_year' });
    await same(PINNED, branchUserId, { preset: 'last_7_days' });
    await same(PINNED, branchUserId, { preset: 'custom', from: 'garbage', to: 'garbage' });
  });

  it('returns exactly the service result for a viewer with only some sections', async () => {
    await same(['dashboard:read', 'report_sales:read'], branchUserId, range);
    await same(['dashboard:read'], branchUserId, range);
  });

  it('returns an empty overview for a user with no branch and no company-wide right', async () => {
    await same(PINNED, noBranchUserId, range);
    const r = await build(PINNED).runner.run<BusinessOverview>(
      'business-overview',
      range,
      noBranchUserId,
    );
    expect(r.ok && r.data.meta.scope.kind).toBe('none');
    expect(r.ok && r.data.sales).toBeNull();
  });

  it('refuses a viewer without dashboard:read before reading anything', async () => {
    const r = await build(PINNED.filter((k) => k !== 'dashboard:read')).runner.run(
      'business-overview',
      range,
      branchUserId,
    );
    expect(r).toMatchObject({ ok: false, code: 'forbidden' });
  });

  it('withholds cost figures from a viewer without the cost permission', async () => {
    const r = await build(
      PINNED.filter((k) => k !== 'report_profit:read'),
    ).runner.run<BusinessOverview>('business-overview', range, branchUserId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.profit).toBeNull();
    expect(r.data.meta.sections).not.toContain('profit');
    expect(JSON.stringify(r.data)).not.toMatch(/grossProfit|costCoveragePct/);
  });

  it('says when it was made and which catalogue it used', async () => {
    const r = await build(PINNED).runner.run('business-overview', range, branchUserId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.meta.code).toBe('business-overview');
    expect(r.meta.asOf).toBe(NOW.toISOString());
    expect(r.meta.tier).toBe('live');
    expect(r.meta.definitionsVersion).toMatch(/^\d{4}-\d{2}-v\d+$/);
    expect(r.meta.tieOut).toEqual({ declared: 'none', checked: false });
  });

  it('shares the overview cache: the second identical run is marked cached', async () => {
    const { runner } = build(PINNED);
    const first = await runner.run('business-overview', range, branchUserId);
    const second = await runner.run('business-overview', range, branchUserId);
    expect(first.ok && first.meta.cached).toBe(false);
    expect(second.ok && second.meta.cached).toBe(true);
  });
});
