import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * Business Overview against a real database (built from the migrations):
 *   TEST_DATABASE_URL=postgres://... pnpm test
 * Everything is attached to a branch made here and a fixed historical day, so other data in a
 * shared database can never change the expected numbers.
 */
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;

describe.skipIf(!url)('business overview (database)', () => {
  let db: typeof import('@/server/db/drizzle/client').drizzleDb;
  let schema: typeof import('@/server/db/drizzle/schema');
  let ReportsService: typeof import('./service').ReportsService;
  let branchId: string;
  let otherBranchId: string;
  let noBranchUserId: string;
  let branchUserId: string;
  let mpesaConfigId: string;

  // 2026-03-10 is the reporting day; "now" is that evening in Nairobi (UTC+3).
  const NOW = new Date('2026-03-10T18:00:00Z');
  const at = (hhmm: string, day = '2026-03-10') => new Date(`${day}T${hhmm}:00+03:00`);
  const range = { preset: 'custom', from: '2026-03-10', to: '2026-03-10' };

  const ALL = [
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
  /** Default viewer: a branch user, so leftovers from other runs in a shared database never count. */
  const PINNED = ALL.filter((k) => k !== 'reports:all_branches');
  const accessFor = (allowed: string[]) => ({
    can: (_user: string, key: string) => Promise.resolve(allowed.includes(key)),
  });
  const service = (allowed: string[] = PINNED) =>
    new ReportsService(db, accessFor(allowed) as never, () => NOW);

  const order = async (
    over: Partial<typeof import('@/server/db/drizzle/schema').orders.$inferInsert>,
    items: {
      qty: number;
      total: string;
      cost: string | null;
      name?: string;
      gift?: boolean;
    }[] = [],
  ) => {
    const id = `ord_${randomUUID()}`;
    await db.insert(schema.orders).values({
      id,
      orderNumber: `RPT-${randomUUID().slice(0, 12)}`,
      branchId,
      customerName: 'Rpt',
      customerEmail: 'rpt@test.local',
      customerPhone: '0',
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
        productId: `prod_rpt_${i}_${it.name ?? 'a'}`,
        productName: it.name ?? 'Widget',
        sku: `S${i}`,
        quantity: it.qty,
        unitPrice: String(Number(it.total) / it.qty),
        totalPrice: it.total,
        unitCost: it.cost,
        isGift: it.gift ?? false,
      });
    }
    return id;
  };

  const attempt = async (orderId: string, provider: string, amount: string, paidAt: Date) => {
    await db.insert(schema.paymentAttempts).values({
      branchId,
      providerConfigId: mpesaConfigId,
      providerCode: provider as never,
      orderId,
      orderNumber: orderId,
      amount,
      status: 'successful',
      callbackToken: randomUUID(),
      callbackUrl: 'http://x',
      paidAt,
    });
  };

  beforeAll(async () => {
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    ({ ReportsService } = await import('./service'));
    const container = (await import('@/server/di/container')).getContainer();
    const companyId = (await container.companySettings.ensureSeeded()).id;
    await db
      .insert(schema.currencies)
      .values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true })
      .onConflictDoNothing();

    const mkBranch = async (n: string) =>
      (
        await db
          .insert(schema.branches)
          .values({ companyId, code: `R${randomUUID().slice(0, 6)}`, name: n })
          .returning()
      )[0]!;
    branchId = (await mkBranch('Rpt Branch')).id;
    otherBranchId = (await mkBranch('Other Branch')).id;

    const mkUser = async (branch: string | null) =>
      (
        await db
          .insert(schema.users)
          .values({
            email: `r-${randomUUID()}@rpt.test`,
            passwordHash: 'x',
            name: 'R',
            role: 'manager',
            branchId: branch,
          })
          .returning()
      )[0]!.id;
    branchUserId = await mkUser(branchId);
    noBranchUserId = await mkUser(null);

    // M-Pesa: enabled with credentials. Jenga: enabled but no credentials. Pesapal: not configured.
    mpesaConfigId = (
      await db
        .insert(schema.paymentProviderConfigs)
        .values({
          companyId,
          branchId,
          providerCode: 'mpesa_daraja',
          displayName: 'M-Pesa Express',
          isEnabled: true,
          apiBaseUrl: 'http://x',
          credentialsEncrypted: { v: 1 } as never,
        })
        .returning()
    )[0]!.id;
    await db.insert(schema.paymentProviderConfigs).values({
      companyId,
      branchId,
      providerCode: 'jenga_hq',
      displayName: 'Jenga',
      isEnabled: true,
      apiBaseUrl: 'http://x',
      credentialsEncrypted: null,
    });

    // --- the reporting day ---
    const o1 = await order({ totalAmount: '1000', tax: '100' }, [
      { qty: 2, total: '1000', cost: '300', name: 'Alpha' },
    ]);
    const o2 = await order({ totalAmount: '500', paymentMethod: 'pesapal_v3' }, [
      { qty: 1, total: '500', cost: null, name: 'Beta' },
    ]);
    await order({ totalAmount: '999', paymentStatus: 'unpaid', status: 'pending' }); // abandoned cart
    await order({ totalAmount: '888', status: 'cancelled' }); // cancelled
    await order({ totalAmount: '777', approvalStatus: 'rejected' }); // refused by approval
    await order({
      totalAmount: '200',
      paymentStatus: 'unpaid',
      status: 'pending',
      tradeCustomerId: null,
    }); // still an abandoned cart
    await order({ totalAmount: '300', currency: 'USD' }); // other currency
    await order({ totalAmount: '50', paymentStatus: 'discrepancy' }); // counts as a sale AND needs attention
    await order({ totalAmount: '999', branchId: otherBranchId }); // another branch's sale
    // --- the day before ---
    await order({ totalAmount: '400', createdAt: at('11:00', '2026-03-09') });

    await attempt(o1, 'mpesa_daraja', '1000', at('10:05'));
    await attempt(o2, 'pesapal_v3', '500', at('10:06')); // provider not configured
    await attempt(randomUUID(), 'mpesa_daraja', '123', at('10:07', '2026-03-09')); // previous day: 123
    // Legacy transaction for an order that already has a successful attempt: must not double count.
    await db.insert(schema.paymentTransactions).values({
      id: `ptx_${randomUUID()}`,
      orderId: o2,
      gatewayProvider: 'pesapal_v3',
      transactionReference: randomUUID(),
      amount: '500',
      status: 'successful',
      updatedAt: at('10:10'),
    });
    // Legacy transaction for an order with no attempt: must be counted (under mpesa).
    const legacyOrder = await order({ totalAmount: '70', createdAt: at('09:00', '2026-03-09') });
    await db.insert(schema.paymentTransactions).values({
      id: `ptx_${randomUUID()}`,
      orderId: legacyOrder,
      gatewayProvider: 'mpesa_daraja',
      transactionReference: randomUUID(),
      amount: '70',
      status: 'successful',
      updatedAt: at('12:00'),
    });

    await db.insert(schema.orderTenders).values({
      orderId: o1,
      kind: 'gift_card',
      reference: 'g1',
      amount: '40',
      actor: 't',
      createdAt: at('10:00'),
    });

    // Receivables: one customer, two open invoices, one overdue by ~45 days.
    const cust = (
      await db
        .insert(schema.customers)
        .values({
          companyId,
          number: `RC-${randomUUID().slice(0, 8)}`,
          name: 'Debtor Ltd',
          accountType: 'credit',
        })
        .returning()
    )[0]!;
    const invOrder = await order({
      totalAmount: '10',
      paymentStatus: 'unpaid',
      createdAt: at('08:00', '2026-01-01'),
    });
    await db.insert(schema.customerLedgerEntries).values([
      {
        companyId,
        customerId: cust.id,
        orderId: invOrder,
        documentType: 'invoice',
        documentNo: 'I1',
        amount: '800',
        remainingAmount: '800',
        dueDate: new Date('2026-01-24T00:00:00Z'),
      },
      {
        companyId,
        customerId: cust.id,
        orderId: invOrder,
        documentType: 'invoice',
        documentNo: 'I2',
        amount: '200',
        remainingAmount: '200',
        dueDate: new Date('2026-04-01T00:00:00Z'),
      },
    ]);
  });

  it('sales: counts real sales only, in base currency, scoped to the branch, with a previous-period comparison', async () => {
    const o = await service().getBusinessOverview(branchUserId, range);
    expect(o.meta.scope.kind).toBe('branch');
    const s = o.sales!;
    // 1000 + 500 + 50 (discrepancy still counts) ; excludes cart, cancelled, rejected, USD, other branch
    expect(s.orders.current).toBe(3);
    expect(s.sales.current).toBe(1550);
    expect(s.tax.current).toBe(100);
    expect(s.averageOrder.current).toBe(516.67);
    // previous day: the 400 order + the 70 legacy order
    expect(s.sales.previous).toBe(470);
    expect(s.sales.changePct).toBe(229.8);
    expect(s.trend).toMatchObject([{ date: '2026-03-10', sales: 1550, orders: 3 }]);
    expect(s.topProducts[0]).toMatchObject({ name: 'Alpha', revenue: 1000, units: 2 });
    expect(o.meta.otherCurrencies).toEqual([{ currency: 'USD', orders: 1 }]);
  });

  it('collections: only configured methods are listed; legacy rows count once; unconfigured is kept separate', async () => {
    const c = (await service().getBusinessOverview(branchUserId, range)).collections!;
    if (!c.configured) throw new Error('expected configured');
    expect(c.methods.map((m) => m.providerCode)).toEqual(['mpesa_daraja']); // jenga has no credentials
    expect(c.methods[0]).toMatchObject({
      name: 'M-Pesa Express',
      amount: 1070,
      count: 2,
      sharePct: 68.2,
    });
    expect(c.unconfigured).toMatchObject({ amount: 500, count: 1, providers: ['Pesapal'] });
    // 1000 + 70 (legacy, no attempt) through M-Pesa, 500 through an unconfigured provider.
    // The legacy Pesapal row for an order that already has an attempt is NOT counted twice.
    expect(c.collected.current).toBe(1570);
    // the day before: only the 123 attempt
    expect(c.collected.previous).toBe(123);
    expect(c.tenders).toEqual({ amount: 40, count: 1 });
  });

  it('collections: reports "not configured" when no method is enabled with credentials', async () => {
    // A company-wide viewer looking at a branch that has no payment methods set up.
    const o = await service(ALL).getBusinessOverview(branchUserId, {
      ...range,
      branchId: otherBranchId,
    });
    expect(o.collections).toMatchObject({
      configured: false,
      setupHref: '/admin/settings/payments',
    });
    // ... which also means nothing else from the collections section leaks through.
    expect(JSON.stringify(o.collections)).not.toContain('amount');
  });

  it('profit: margin is based only on lines with a known cost, and says how much that covers', async () => {
    const p = (await service().getBusinessOverview(branchUserId, range)).profit!;
    // known: Alpha 1000 revenue, cost 600 -> profit 400 ; Beta (500) and the 50 order have no lines/cost
    expect(p.grossProfit.current).toBe(400);
    expect(p.marginPct).toBe(40);
    expect(p.costCoveragePct).toBe(66.7);
  });

  it('receivables: ages open invoices as of now and names the biggest overdue debtor', async () => {
    const r = (await service().getBusinessOverview(branchUserId, range)).receivables!;
    expect(r.outstanding).toBe(1000);
    expect(r.overdue).toBe(800);
    expect(r.overdueCustomers).toBe(1);
    expect(r.aging.find((a) => a.label === '31–60 days late')?.amount).toBe(800);
    expect(r.topDebtors[0]).toMatchObject({ name: 'Debtor Ltd', overdue: 800, outstanding: 1000 });
  });

  it('attention: shows only what the user can act on', async () => {
    const withOrders = await service().getBusinessOverview(branchUserId, range);
    expect(withOrders.attention.map((a) => a.key)).toContain('payment_discrepancies');
    const without = await service(['report_sales:read']).getBusinessOverview(branchUserId, range);
    expect(without.attention.map((a) => a.key)).not.toContain('payment_discrepancies');
  });

  it('gating: sections the user lacks are never computed or returned', async () => {
    const o = await service(['report_sales:read']).getBusinessOverview(branchUserId, range);
    expect(o.meta.sections).toEqual(['sales']);
    expect(o.sales).not.toBeNull();
    expect(o.collections).toBeNull();
    expect(o.profit).toBeNull();
    expect(o.receivables).toBeNull();
    expect(o.inventory).toBeNull();
    expect(o.branches).toBeNull();
  });

  it('scope: a branch user cannot widen to another branch; no-branch users see nothing', async () => {
    const pinned = await service().getBusinessOverview(branchUserId, {
      ...range,
      branchId: otherBranchId,
    });
    expect(pinned.meta.scope.label).toBe('Rpt Branch');
    expect(pinned.sales!.sales.current).toBe(1550);
    expect(pinned.branches).toBeNull(); // no branch picker for pinned users

    const wide = await service(ALL).getBusinessOverview(branchUserId, {
      ...range,
      branchId: otherBranchId,
    });
    expect(wide.meta.scope.label).toBe('Other Branch');
    expect(wide.sales!.sales.current).toBe(999);

    const none = await service().getBusinessOverview(noBranchUserId, range);
    expect(none.meta.scope.kind).toBe('none');
    expect(none.sales).toBeNull();
  });

  it('is repeatable: the same request returns identical figures, and a second read can be served from the short cache', async () => {
    const s = service();
    const a = await s.getBusinessOverview(branchUserId, range);
    const b = await s.getBusinessOverview(branchUserId, range);
    expect(b.meta.cached).toBe(true);
    expect({ ...b, meta: { ...b.meta, cached: false } }).toEqual(a);
    expect((await service().getBusinessOverview(branchUserId, range)).sales).toEqual(a.sales);
  });

  it('order flow explains every order: sale buckets add up to the sales figure, the rest is accounted for', async () => {
    const sales = (await service().getBusinessOverview(branchUserId, range)).sales!;
    const flow = Object.fromEntries(sales.flow.map((f) => [f.key, f]));
    expect(flow.paid).toMatchObject({ count: 2, value: 1500 });
    expect(flow.awaiting).toMatchObject({ count: 1, value: 50 });
    expect(flow.unpaid).toMatchObject({ count: 2, value: 1199 });
    expect(flow.blocked).toMatchObject({ count: 1, value: 777 });
    expect(flow.lost).toMatchObject({ count: 1, value: 888 });
    const counted = sales.flow.filter((f) => f.countsAsSale);
    expect(counted.reduce((s, f) => s + f.value, 0)).toBe(sales.sales.current);
    expect(counted.reduce((s, f) => s + f.count, 0)).toBe(sales.orders.current);
  });

  it('collections: shows the collection rate and money still in flight', async () => {
    const c = (await service().getBusinessOverview(branchUserId, range)).collections!;
    if (!c.configured) throw new Error('expected configured');
    expect(c.collectionRatePct).toBe(101.3); // 1570 collected / 1550 sales
    expect(c.inFlight).toMatchObject({ pendingCount: 0, failedCount: 0 });
  });

  it('trend carries the comparison day for every day, and the headline reads the numbers back', async () => {
    const o = await service().getBusinessOverview(branchUserId, range);
    expect(o.sales!.trend[0]).toMatchObject({
      date: '2026-03-10',
      previousDate: '2026-03-09',
      previousSales: 470,
    });
    expect(o.headline[0]).toContain(
      'Sales were KES 1,550 from 3 orders, up 229.8% on previous period',
    );
    expect(o.meta.compare).toEqual({ mode: 'previous_period', label: 'Previous period' });
  });

  it('compare with last year uses the same dates a year earlier', async () => {
    const o = await service().getBusinessOverview(branchUserId, {
      ...range,
      compare: 'previous_year',
    });
    expect(o.meta.period.previousFromDate).toBe('2025-03-10');
    expect(o.sales!.sales.previous).toBe(0);
    expect(o.sales!.sales.changePct).toBeNull();
  });

  it('points an empty period at the latest real activity', async () => {
    const o = await service().getBusinessOverview(branchUserId, {
      preset: 'custom',
      from: '2026-03-05',
      to: '2026-03-05',
    });
    expect(o.sales!.orders.current).toBe(0);
    expect(o.meta.lastActivityDate).toBe('2026-03-10');
  });

  it('branch breakdown appears only for company-wide viewers and sums their shares', async () => {
    const wide = (await service(ALL).getBusinessOverview(branchUserId, range)).sales!;
    expect(wide.byBranch).not.toBeNull();
    // Many branches in a shared database: the tail is folded into one row, so shares still add up.
    const share = wide.byBranch!.reduce((s, b) => s + b.sharePct, 0);
    expect(share).toBeGreaterThan(99.5);
    expect(share).toBeLessThan(100.5);
    expect((await service().getBusinessOverview(branchUserId, range)).sales!.byBranch).toBeNull();
  });

  it('a changed comparison is never answered from the short cache', async () => {
    const s = service();
    const a = await s.getBusinessOverview(branchUserId, range);
    const b = await s.getBusinessOverview(branchUserId, { ...range, compare: 'previous_year' });
    expect(b.meta.cached).toBe(false);
    expect(a.meta.period.previousFromDate).toBe('2026-03-09');
    expect(b.meta.period.previousFromDate).toBe('2025-03-10');
    expect(b.meta.compare.mode).toBe('previous_year');
  });
});
