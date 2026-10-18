import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';

/**
 * Rebates, loyalty points, gift cards and paying orders with them, against a real database.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 * The database is shared, so every programme is limited to customers or products made here.
 */
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;

describe.skipIf(!url)('rebates, loyalty, gift cards and tenders (database)', () => {
  type Container = ReturnType<typeof import('@/server/di/container').getContainer>;
  let c: Container;
  let db: typeof import('@/server/db/drizzle/client').drizzleDb;
  let schema: typeof import('@/server/db/drizzle/schema');
  let companyId: string;
  let itemTypeId: string;
  let branchId: string;

  const actor = { type: 'user' as const, id: 'p4-test' };
  const reason = { code: 'POLICY_CHANGE' };

  const user = async () =>
    (
      await db
        .insert(schema.users)
        .values({
          email: `p4-${randomUUID()}@p4.test`,
          passwordHash: 'x',
          name: 'P4',
          role: 'manager',
        })
        .returning()
    )[0]!;

  const customer = async (over: Record<string, unknown> = {}) =>
    (
      await db
        .insert(schema.customers)
        .values({
          companyId,
          number: `P4-${randomUUID().slice(0, 10)}`,
          name: 'P4 Customer',
          email: `p4c-${randomUUID()}@p4.test`,
          accountType: 'cash',
          ...over,
        })
        .returning()
    )[0]!;

  const product = async (over: Record<string, unknown> = {}) => {
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({
      id,
      sku: `P4-${randomUUID().slice(0, 8)}`.toUpperCase(),
      stockCode: `P4S-${randomUUID().slice(0, 8)}`.toUpperCase(),
      name: `P4 product ${randomUUID().slice(0, 4)}`,
      slug: `p4-${randomUUID()}`,
      itemTypeId,
      price: '100',
      costPrice: '0',
      taxRate: '0',
      isTaxInclusive: true,
      stockQuantity: 500,
      ...over,
    });
    return id;
  };
  const prodRow = async (id: string) =>
    (await db.select().from(schema.products).where(eq(schema.products.id, id)))[0]!;
  const orderRow = async (id: string) =>
    (await db.select().from(schema.orders).where(eq(schema.orders.id, id)))[0]!;

  const order = async (
    email: string,
    items: Array<[string, number]>,
    over: Record<string, unknown> = {},
  ) => {
    const { OrderWriteService } = await import('@/server/domains/orders/write-service');
    return OrderWriteService.createOrder({
      branchId,
      orderNumber: `P4-${randomUUID()}`,
      customerName: 'P4 Buyer',
      customerEmail: email,
      customerPhone: '0700000000',
      shippingAddress: { street: '1 Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' },
      items: items.map(([productId, quantity]) => ({ productId, quantity })),
      currency: 'KES',
      paymentMethod: 'mpesa_daraja' as never,
      salesModule: 'sales_order',
      ...over,
    });
  };
  const cancel = async (orderId: string) => {
    const { InventoryReservationService } =
      await import('@/server/domains/inventory/reservation-service');
    await InventoryReservationService.releaseOrder(orderId, 'test cancel', 'p4-test');
  };

  const programInput = (over: Record<string, unknown> = {}) => ({
    code: `RB-${randomUUID().slice(0, 8)}`,
    name: 'Test rebate',
    period: 'quarter' as const,
    tierMode: 'all_sales' as const,
    tiers: [
      { from: 1000, percent: 1 },
      { from: 5000, percent: 2 },
    ],
    scopes: {},
    target: { all: true },
    validFrom: new Date(Date.now() - 86400_000 * 400),
    validTo: null,
    ...over,
  });
  const liveProgram = async (customerId: string, over: Record<string, unknown> = {}) => {
    const p = await c.rebateConfig.create(
      companyId,
      programInput({ scopes: { customer: { op: 'in', values: [customerId] } }, ...over }) as never,
      actor,
      reason,
    );
    await c.rebateConfig.activate(companyId, p.id, actor, reason);
    c.rebates.invalidate(companyId);
    return p;
  };
  const balance = async (programId: string, customerId: string, key?: string) =>
    (
      await db
        .select()
        .from(schema.rebateBalances)
        .where(
          and(
            eq(schema.rebateBalances.programId, programId),
            eq(schema.rebateBalances.customerId, customerId),
            ...(key ? [eq(schema.rebateBalances.periodKey, key)] : []),
          ),
        )
    ).reduce((n, b) => n + Number(b.basis), 0);

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    itemTypeId = `it_p4_${randomUUID().slice(0, 8)}`;
    await db
      .insert(schema.itemTypes)
      .values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    await db
      .insert(schema.currencies)
      .values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true })
      .onConflictDoNothing();
    const { branch } = await c.organizations.ensureDefaultOrgAndBranch(companyId, 'P4 Co');
    branchId = ((await c.branches.getDefault(companyId)) || branch).id;
  });

  // ── Rebate programmes ────────────────────────────────────────────────────

  describe('setting up a rebate programme', () => {
    it('is made as a draft, logged with its reason, and needs a unique code', async () => {
      const p = await c.rebateConfig.create(companyId, programInput() as never, actor, reason);
      expect(p).toMatchObject({ status: 'draft', version: 1 });
      expect((await c.rebateConfig.timeline(p.id)).map((l) => l.action)).toContain(
        'pricing.rebate_program_created',
      );
      await expect(
        c.rebateConfig.create(
          companyId,
          programInput({ code: p.code.toLowerCase() }) as never,
          actor,
          reason,
        ),
      ).rejects.toMatchObject({ code: 'DUPLICATE_CODE' });
      await expect(
        c.rebateConfig.create(companyId, programInput() as never, actor, { code: '' }),
      ).rejects.toThrow();
    });

    it('refuses steps that make no sense', async () => {
      await expect(
        c.rebateConfig.create(companyId, programInput({ tiers: [] }) as never, actor, reason),
      ).rejects.toMatchObject({ code: 'INVALID' });
      await expect(
        c.rebateConfig.create(
          companyId,
          programInput({ tiers: [{ from: 1, percent: 90 }] }) as never,
          actor,
          reason,
        ),
      ).rejects.toMatchObject({ code: 'INVALID' });
    });

    it('cannot be edited while in force, but can once paused (and the version moves on)', async () => {
      const cust = await customer();
      const p = await liveProgram(cust.id);
      await expect(
        c.rebateConfig.update(
          companyId,
          p.id,
          programInput({ code: p.code, name: 'x' }) as never,
          actor,
          reason,
        ),
      ).rejects.toMatchObject({ code: 'NOT_EDITABLE' });
      await c.rebateConfig.pause(companyId, p.id, actor, reason);
      const edited = await c.rebateConfig.update(
        companyId,
        p.id,
        programInput({ code: p.code, name: 'Renamed', scopes: p.scopes }) as never,
        actor,
        reason,
      );
      expect(edited).toMatchObject({ name: 'Renamed', version: 2 });
    });

    it('cannot change its period length once purchases are counted', async () => {
      const cust = await customer();
      const p = await liveProgram(cust.id);
      await db.transaction((tx) =>
        c.rebates.accrueOrder(tx, { companyId, customerId: cust.id }, `ord_${randomUUID()}`, [
          { productId: 'any', net: 500 },
        ]),
      );
      await c.rebateConfig.pause(companyId, p.id, actor, reason);
      await expect(
        c.rebateConfig.update(
          companyId,
          p.id,
          programInput({ code: p.code, period: 'month', scopes: p.scopes }) as never,
          actor,
          reason,
        ),
      ).rejects.toMatchObject({ code: 'LOCKED' });
    });
  });

  // ── Accruals ─────────────────────────────────────────────────────────────

  describe('counting purchases', () => {
    it("an order adds its net value (tax left out) to the customer's total", async () => {
      const cust = await customer();
      const p = await liveProgram(cust.id);
      const prod = await product({ price: '116', taxRate: '16', isTaxInclusive: true });
      const res = await order(cust.email!, [[prod, 10]]);
      expect(res.success).toBe(true);
      expect(await balance(p.id, cust.id)).toBe(1000);
    });

    it('counts only products the programme covers, and only its customers', async () => {
      const cust = await customer();
      const other = await customer();
      const covered = await product({ price: '100' });
      const notCovered = await product({ price: '100' });
      const p = await liveProgram(cust.id, { target: { productIds: [covered] } });
      await order(cust.email!, [
        [covered, 3],
        [notCovered, 5],
      ]);
      expect(await balance(p.id, cust.id)).toBe(300);
      await order(other.email!, [[covered, 3]]);
      expect(await balance(p.id, other.id)).toBe(0);
    });

    it('ignores a paused programme', async () => {
      const cust = await customer();
      const p = await liveProgram(cust.id);
      await c.rebateConfig.pause(companyId, p.id, actor, reason);
      c.rebates.invalidate(companyId);
      const prod = await product();
      await order(cust.email!, [[prod, 2]]);
      expect(await balance(p.id, cust.id)).toBe(0);
    });

    it('takes a cancelled order back out, once', async () => {
      const cust = await customer();
      const p = await liveProgram(cust.id);
      const prod = await product();
      const res = await order(cust.email!, [[prod, 4]]);
      expect(await balance(p.id, cust.id)).toBe(400);
      await cancel(res.order!.id);
      expect(await balance(p.id, cust.id)).toBe(0);
      await cancel(res.order!.id);
      expect(await balance(p.id, cust.id)).toBe(0);
      const rows = await db
        .select()
        .from(schema.rebateAccruals)
        .where(eq(schema.rebateAccruals.programId, p.id));
      expect(rows.map((r) => r.sourceType).sort()).toEqual(['order', 'order_cancel']);
    });

    it('a credit note takes back what it returned, never more than the order counted', async () => {
      const cust = await customer();
      const p = await liveProgram(cust.id);
      const prod = await product();
      const res = await order(cust.email!, [[prod, 10]]);
      await db.transaction((tx) =>
        c.rebates.accrueCredit(tx, { companyId, orderId: res.order!.id, creditNoteId: 'cn-1' }, [
          { productId: prod, net: 300 },
        ]),
      );
      expect(await balance(p.id, cust.id)).toBe(700);
      await db.transaction((tx) =>
        c.rebates.accrueCredit(tx, { companyId, orderId: res.order!.id, creditNoteId: 'cn-2' }, [
          { productId: prod, net: 5000 },
        ]),
      );
      expect(await balance(p.id, cust.id)).toBe(0);
    });

    it('files an order under the period it happened in', async () => {
      const cust = await customer();
      const p = await liveProgram(cust.id);
      await db.transaction((tx) =>
        c.rebates.accrueOrder(
          tx,
          { companyId, customerId: cust.id, at: new Date('2026-02-10T09:00:00Z') },
          `ord_${randomUUID()}`,
          [{ productId: 'any', net: 800 }],
        ),
      );
      expect(await balance(p.id, cust.id, '2026-Q1')).toBe(800);
    });

    it('is safe to count the same order twice', async () => {
      const cust = await customer();
      const p = await liveProgram(cust.id);
      const id = `ord_${randomUUID()}`;
      const sale = { companyId, customerId: cust.id };
      await db.transaction((tx) =>
        c.rebates.accrueOrder(tx, sale, id, [{ productId: 'a', net: 100 }]),
      );
      await db.transaction((tx) =>
        c.rebates.accrueOrder(tx, sale, id, [{ productId: 'a', net: 100 }]),
      );
      expect(await balance(p.id, cust.id)).toBe(100);
    });
  });

  describe('statements', () => {
    it('shows each customer, the rate reached and how far the next step is', async () => {
      const a = await customer();
      const p = await liveProgram(a.id);
      await db.transaction((tx) =>
        c.rebates.accrueOrder(
          tx,
          { companyId, customerId: a.id, at: new Date('2026-03-01T09:00:00Z') },
          `o-${randomUUID()}`,
          [{ productId: 'x', net: 2000 }],
        ),
      );
      const s = await c.rebateConfig.statement(companyId, p.id, '2026-Q1');
      expect(s.ended).toBe(true);
      expect(s.rows).toHaveLength(1);
      expect(s.rows[0]).toMatchObject({
        basis: 2000,
        percent: 1,
        amount: 20,
        next: { needed: 3000, percent: 2 },
      });
      expect(s.totalAmount).toBe(20);
      expect((await c.rebateConfig.periods(companyId, p.id)).map((x) => x.key)).toContain(
        '2026-Q1',
      );
    });
  });

  // ── Settlement ───────────────────────────────────────────────────────────

  describe('paying a rebate', () => {
    const creditCustomer = async (owed: number[]) => {
      const cust = await customer({
        accountType: 'credit',
        creditLimit: '1000000',
        balance: String(owed.reduce((n, x) => n + x, 0)),
      });
      for (const [i, amount] of owed.entries()) {
        const [entry] = await db
          .insert(schema.customerLedgerEntries)
          .values({
            companyId,
            customerId: cust.id,
            documentType: 'invoice',
            documentNo: `INV-${randomUUID().slice(0, 6)}`,
            amount: amount.toFixed(2),
            remainingAmount: amount.toFixed(2),
            createdAt: new Date(Date.now() - (10 - i) * 86400_000),
          })
          .returning();
        // As every posted invoice has: its opening entry in the history.
        await db.insert(schema.customerDetailedEntries).values({
          companyId,
          customerId: cust.id,
          ledgerEntryId: entry!.id,
          entryType: 'initial',
          amount: amount.toFixed(2),
        });
      }
      return cust;
    };
    const earn = async (
      programId: string,
      customerId: string,
      net: number,
      at = new Date('2026-03-01T09:00:00Z'),
    ) => {
      const sale = { companyId, customerId, at };
      await db.transaction((tx) =>
        c.rebates.accrueOrder(tx, sale, `o-${randomUUID()}`, [{ productId: 'x', net }]),
      );
      void programId;
    };
    const requester = { type: 'user' as const, id: 'p4-requester' };

    it('credits the account, reducing open invoices oldest first, and records why', async () => {
      const cust = await creditCustomer([300, 500]);
      const p = await liveProgram(cust.id);
      await earn(p.id, cust.id, 2000); // 1% of 2000 = 20... use bigger below
      await earn(p.id, cust.id, 28_000, new Date('2026-03-02T09:00:00Z')); // 30,000 -> still 2% = 600
      // Raise the tier thresholds out of the way by reading the statement: 30,000 at 2% = 600.
      const out = await c.rebateConfig.requestSettlement(
        companyId,
        { programId: p.id, customerId: cust.id, periodKey: '2026-Q1' },
        requester,
        reason,
      );
      expect(out.outcome).toBe('settled');
      const s = (await c.rebateConfig.listSettlements(companyId, p.id))[0]!;
      expect(s).toMatchObject({ status: 'settled', amount: '600.00', periodKey: '2026-Q1' });
      expect(s.creditRef).toMatch(/^RBT-2026-Q1-/);
      const ledger = await db
        .select()
        .from(schema.customerLedgerEntries)
        .where(eq(schema.customerLedgerEntries.customerId, cust.id));
      const invoices = ledger
        .filter((l) => l.documentType === 'invoice')
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      expect(invoices.map((i) => Number(i.remainingAmount))).toEqual([0, 200]);
      expect(ledger.find((l) => l.documentType === 'rebate_credit')).toMatchObject({
        amount: '-600.00',
      });
      // What is open on every entry still equals the sum of its history.
      const drift = await db.execute(sql`
        SELECT e.id FROM customer_ledger_entries e
        LEFT JOIN customer_detailed_entries d ON d.ledger_entry_id = e.id
        WHERE e.customer_id = ${cust.id}::uuid
        GROUP BY e.id, e.remaining_amount
        HAVING e.remaining_amount <> COALESCE(SUM(d.amount), 0)`);
      expect([...drift]).toEqual([]);
      const [after] = await db
        .select()
        .from(schema.customers)
        .where(eq(schema.customers.id, cust.id));
      expect(Number(after!.balance)).toBe(200);
      expect(
        (await c.decisionLog.timeline('rebate_settlement', s.id)).map((l) => l.action),
      ).toEqual(
        expect.arrayContaining(['pricing.rebate_settlement_requested', 'pricing.rebate_settled']),
      );
    });

    it('is paid only once for a customer and period', async () => {
      const cust = await creditCustomer([5000]);
      const p = await liveProgram(cust.id);
      await earn(p.id, cust.id, 2000);
      const ask = () =>
        c.rebateConfig.requestSettlement(
          companyId,
          { programId: p.id, customerId: cust.id, periodKey: '2026-Q1' },
          requester,
          reason,
        );
      await ask();
      await expect(ask()).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('waits for the period to finish, and for the first step to be reached', async () => {
      const cust = await creditCustomer([5000]);
      const p = await liveProgram(cust.id);
      await earn(p.id, cust.id, 100, new Date('2026-03-01T09:00:00Z'));
      await expect(
        c.rebateConfig.requestSettlement(
          companyId,
          { programId: p.id, customerId: cust.id, periodKey: '2026-Q1' },
          requester,
          reason,
        ),
      ).rejects.toThrow(/first step/);
      await expect(
        c.rebateConfig.requestSettlement(
          companyId,
          { programId: p.id, customerId: cust.id, periodKey: '2099-Q1' },
          requester,
          reason,
        ),
      ).rejects.toThrow(/not finished/);
    });

    it('is only for account customers, and only up to what they owe', async () => {
      const cash = await customer();
      const p1 = await liveProgram(cash.id);
      await earn(p1.id, cash.id, 2000);
      await expect(
        c.rebateConfig.requestSettlement(
          companyId,
          { programId: p1.id, customerId: cash.id, periodKey: '2026-Q1' },
          requester,
          reason,
        ),
      ).rejects.toThrow(/no account to credit/);

      const owes = await creditCustomer([5]);
      const p2 = await liveProgram(owes.id);
      await earn(p2.id, owes.id, 2000);
      await expect(
        c.rebateConfig.requestSettlement(
          companyId,
          { programId: p2.id, customerId: owes.id, periodKey: '2026-Q1' },
          requester,
          reason,
        ),
      ).rejects.toThrow(/owes 5.00/);
      // Nothing was posted, and the request can be made again later.
      const left = await c.rebateConfig.listSettlements(companyId, p2.id);
      expect(left.every((s) => s.status !== 'settled')).toBe(true);
    });

    describe('with an approval workflow', () => {
      async function workflowFor(requesterId: string, approver: string) {
        const wf = await c.approvalConfig.createWorkflow(
          companyId,
          {
            code: `RW-${randomUUID().slice(0, 8)}`,
            name: 'Rebate approval',
            trigger: 'rebate.settle',
          },
          actor,
        );
        await c.approvalConfig.saveDraft(
          companyId,
          wf.id,
          {
            conditions: { op: 'eq', field: 'requestedBy', value: requesterId },
            steps: [
              { sequence: 1, name: 'Approver', approver: { type: 'user', userId: approver } },
            ],
          } as never,
          actor,
        );
        await c.approvalConfig.publish(companyId, wf.id, actor, reason);
      }
      const tx = <T>(fn: (t: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>) =>
        db.transaction(fn);

      it('holds the payment until approved, then posts the credit', async () => {
        const req = await user();
        const approver = await user();
        await workflowFor(req.id, approver.id);
        const cust = await creditCustomer([5000]);
        const p = await liveProgram(cust.id);
        await earn(p.id, cust.id, 2000);
        const out = await c.rebateConfig.requestSettlement(
          companyId,
          { programId: p.id, customerId: cust.id, periodKey: '2026-Q1' },
          { type: 'user', id: req.id },
          reason,
        );
        expect(out.outcome).toBe('pending');
        expect((await c.rebateConfig.listSettlements(companyId, p.id))[0]).toMatchObject({
          status: 'pending',
          approvalStatus: 'pending',
        });
        const [before] = await db
          .select()
          .from(schema.customers)
          .where(eq(schema.customers.id, cust.id));
        expect(Number(before!.balance)).toBe(5000);
        const entry = (await c.approvals.inbox(approver.id)).find(
          (e) => e.documentKind === 'rebate_settlement',
        )!;
        await tx((t) => c.approvals.approve(entry.entryId, approver.id, null, t));
        expect((await c.rebateConfig.listSettlements(companyId, p.id))[0]).toMatchObject({
          status: 'settled',
        });
        const [after] = await db
          .select()
          .from(schema.customers)
          .where(eq(schema.customers.id, cust.id));
        expect(Number(after!.balance)).toBe(4980);
      });

      it('a refusal closes it, and it can be asked for again', async () => {
        const req = await user();
        const approver = await user();
        await workflowFor(req.id, approver.id);
        const cust = await creditCustomer([5000]);
        const p = await liveProgram(cust.id);
        await earn(p.id, cust.id, 2000);
        const ask = () =>
          c.rebateConfig.requestSettlement(
            companyId,
            { programId: p.id, customerId: cust.id, periodKey: '2026-Q1' },
            { type: 'user', id: req.id },
            reason,
          );
        await ask();
        const entry = (await c.approvals.inbox(approver.id)).find(
          (e) => e.documentKind === 'rebate_settlement',
        )!;
        await tx((t) =>
          c.approvals.reject(
            entry.entryId,
            approver.id,
            { reasonCode: 'OTHER', comment: 'Disputed' },
            t,
          ),
        );
        expect((await c.rebateConfig.listSettlements(companyId, p.id))[0]).toMatchObject({
          status: 'rejected',
        });
        expect((await ask()).outcome).toBe('pending');
      });

      it("does not post if the customer's purchases changed after it was asked for", async () => {
        const req = await user();
        const approver = await user();
        await workflowFor(req.id, approver.id);
        const cust = await creditCustomer([5000]);
        const p = await liveProgram(cust.id);
        await earn(p.id, cust.id, 2000);
        await c.rebateConfig.requestSettlement(
          companyId,
          { programId: p.id, customerId: cust.id, periodKey: '2026-Q1' },
          { type: 'user', id: req.id },
          reason,
        );
        // A credit note lands in the closed period before the approver acts.
        await db.transaction((tx2) =>
          tx2
            .update(schema.rebateBalances)
            .set({ basis: '1500.00' })
            .where(
              and(
                eq(schema.rebateBalances.programId, p.id),
                eq(schema.rebateBalances.customerId, cust.id),
              ),
            ),
        );
        const entry = (await c.approvals.inbox(approver.id)).find(
          (e) => e.documentKind === 'rebate_settlement',
        )!;
        await expect(
          tx((t) => c.approvals.approve(entry.entryId, approver.id, null, t)),
        ).rejects.toThrow();
        expect((await c.rebateConfig.listSettlements(companyId, p.id))[0]).toMatchObject({
          status: 'pending',
        });
      });
    });
  });

  // ── Loyalty ──────────────────────────────────────────────────────────────

  describe('loyalty points', () => {
    const config = (over: Record<string, unknown> = {}) => ({
      pointsPer100: 1,
      pointValue: 1,
      minRedeemPoints: 1,
      maxRedeemPercent: 100,
      expiryMonths: 12,
      tiers: [{ name: 'Silver', fromPoints: 100, multiplier: 2 }],
      ...over,
    });
    const run = (over: Record<string, unknown> = {}, status: 'active' | 'paused' = 'active') =>
      c.loyalty.saveProgram(
        companyId,
        { name: 'Test loyalty', status, config: config(over) as never },
        actor,
        reason,
      );
    const points = async (customerId: string) =>
      (await c.loyalty.account(companyId, customerId)).balance;

    it('is set up with a reason, logged, and refuses nonsense', async () => {
      const v = await run();
      expect(v).toMatchObject({ status: 'active' });
      expect(v.summary).toContain('1 point(s) for every 100 spent');
      await expect(run({ pointValue: 0 })).rejects.toMatchObject({ code: 'INVALID' });
      await expect(
        c.loyalty.saveProgram(
          companyId,
          { name: 'x', status: 'active', config: config() as never },
          actor,
          { code: '' },
        ),
      ).rejects.toThrow();
    });

    it('an order earns points on its net value, rounded down, and a cancel takes them back', async () => {
      await run();
      const cust = await customer();
      const prod = await product({ price: '199' });
      const res = await order(cust.email!, [[prod, 1]]);
      expect(await points(cust.id)).toBe(1); // 199 / 100 = 1.99 -> 1
      await cancel(res.order!.id);
      expect(await points(cust.id)).toBe(0);
      await cancel(res.order!.id);
      expect(await points(cust.id)).toBe(0);
    });

    it('a higher tier earns faster, from lifetime points', async () => {
      await run();
      const cust = await customer();
      const prod = await product({ price: '100' });
      await c.loyalty.adjust(companyId, cust.id, 100, 'welcome', actor, reason);
      expect((await c.loyalty.account(companyId, cust.id)).tier?.name).toBe('Silver');
      await order(cust.email!, [[prod, 10]]); // 1000 spend -> 10 points x 2
      expect(await points(cust.id)).toBe(120);
    });

    it('earns nothing while the programme is paused', async () => {
      await run({}, 'paused');
      const cust = await customer();
      const prod = await product({ price: '1000' });
      await order(cust.email!, [[prod, 1]]);
      expect(await points(cust.id)).toBe(0);
      await run({}, 'active');
    });

    it('staff can add or take points with a reason, never below zero', async () => {
      await run();
      const cust = await customer();
      await c.loyalty.adjust(companyId, cust.id, 50, 'goodwill', actor, reason);
      await expect(c.loyalty.adjust(companyId, cust.id, -80, null, actor, reason)).rejects.toThrow(
        /take away/,
      );
      const a = await c.loyalty.adjust(companyId, cust.id, -20, 'correction', actor, reason);
      expect(a.balance).toBe(30);
      expect(a.ledger.map((l) => l.kind)).toEqual(['adjust', 'adjust']);
      await expect(c.loyalty.adjust(companyId, cust.id, 0, null, actor, reason)).rejects.toThrow(
        /whole number/,
      );
    });

    it('a credit note takes back its share of the points, once the cancel takes the rest', async () => {
      await run({ tiers: [] });
      const cust = await customer();
      const prod = await product({ price: '100' });
      const res = await order(cust.email!, [[prod, 10]]); // 1000 -> 10 points
      expect(await points(cust.id)).toBe(10);
      const claw = await db.transaction((tx) =>
        c.loyalty.clawbackCredit(tx, {
          orderId: res.order!.id,
          creditNoteNo: 'CN-1',
          fraction: 0.3,
        }),
      );
      expect(claw).toBe(3);
      expect(await points(cust.id)).toBe(7);
      await cancel(res.order!.id);
      expect(await points(cust.id)).toBe(0);
    });

    it('lapses points that were not spent in time, counting spending against the oldest first', async () => {
      await run({ expiryMonths: 1, tiers: [] });
      const cust = await customer();
      const old = new Date(Date.now() - 86400_000);
      const later = new Date(Date.now() + 86400_000 * 20);
      // 10 points that have lapsed, 20 that have not, 4 already spent.
      await db
        .insert(schema.loyaltyAccounts)
        .values({ customerId: cust.id, companyId, balance: 26, lifetimeEarned: 30 });
      await db.insert(schema.loyaltyLedger).values([
        {
          companyId,
          customerId: cust.id,
          kind: 'earn',
          points: 10,
          orderId: `o-${randomUUID()}`,
          expiresAt: old,
          actor: 'x',
        },
        {
          companyId,
          customerId: cust.id,
          kind: 'earn',
          points: 20,
          orderId: `o-${randomUUID()}`,
          expiresAt: later,
          actor: 'x',
        },
        {
          companyId,
          customerId: cust.id,
          kind: 'redeem',
          points: -4,
          orderId: `o-${randomUUID()}`,
          actor: 'x',
        },
      ]);
      expect(await points(cust.id)).toBe(26);
      await c.loyalty.expireDue(companyId);
      expect(await points(cust.id)).toBe(20); // 10 lapsed less the 4 spent first = 6 lapse
      const ledger = (await c.loyalty.account(companyId, cust.id)).ledger;
      expect(ledger.find((l) => l.kind === 'expire')?.points).toBe(-6);
      // A second sweep finds nothing more to lapse.
      await c.loyalty.expireDue(companyId);
      expect(await points(cust.id)).toBe(20);
    });
  });

  // ── Gift cards ───────────────────────────────────────────────────────────

  describe('gift cards', () => {
    it('are issued with unique readable codes, a ledger entry and a decision', async () => {
      const cards = await c.giftCards.issue(
        companyId,
        { funding: { kind: 'complimentary' }, value: 500, count: 3, note: 'Promo' },
        actor,
        reason,
      );
      expect(cards).toHaveLength(3);
      expect(new Set(cards.map((x) => x.code)).size).toBe(3);
      expect(cards[0]).toMatchObject({ balance: 500, initialValue: 500, usable: true });
      const detail = await c.giftCards.lookup(
        companyId,
        cards[0]!.code.toLowerCase().replace(/-/g, ' '),
      );
      expect(detail.ledger.map((l) => l.kind)).toEqual(['issue']);
      expect(
        (await c.decisionLog.timeline('gift_card', cards[0]!.id)).map((l) => l.action),
      ).toContain('pricing.gift_card_issued');
      await expect(c.giftCards.lookup(companyId, 'NOPE-NOPE-NOPE-NOPE')).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('refuses silly values, and a past expiry', async () => {
      await expect(c.giftCards.issue(companyId, { funding: { kind: 'complimentary' }, value: 0 }, actor, reason)).rejects.toMatchObject(
        { code: 'INVALID' },
      );
      await expect(
        c.giftCards.issue(
          companyId,
          { funding: { kind: 'complimentary' }, value: 10, expiresAt: new Date('2020-01-01') },
          actor,
          reason,
        ),
      ).rejects.toMatchObject({ code: 'INVALID' });
      await expect(
        c.giftCards.issue(companyId, { funding: { kind: 'complimentary' }, value: 10, count: 9999 }, actor, reason),
      ).rejects.toMatchObject({ code: 'INVALID' });
    });

    it('two orders spending one card at once cannot both get the money', async () => {
      const [card] = await c.giftCards.issue(companyId, { funding: { kind: 'complimentary' }, value: 100 }, actor, reason);
      const attempt = (orderId: string) =>
        db
          .transaction((tx) =>
            c.giftCards.redeem(tx, {
              companyId,
              code: card!.code,
              amount: 100,
              orderId,
              actor: 'x',
            }),
          )
          .then(() => 'ok' as const)
          .catch(() => 'refused' as const);
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) => attempt(`ord-race-${i}-${randomUUID()}`)),
      );
      expect(results.filter((r) => r === 'ok')).toHaveLength(1);
      expect((await c.giftCards.lookup(companyId, card!.code)).balance).toBe(0);
    });

    it('a blocked, expired or empty card cannot be used, and says why', async () => {
      const [blocked] = await c.giftCards.issue(companyId, { funding: { kind: 'complimentary' }, value: 100 }, actor, reason);
      await c.giftCards.setBlocked(companyId, blocked!.id, true, actor, reason);
      await expect(
        db.transaction((tx) =>
          c.giftCards.redeem(tx, {
            companyId,
            code: blocked!.code,
            amount: 10,
            orderId: 'o1',
            actor: 'x',
          }),
        ),
      ).rejects.toThrow(/blocked/);
      await c.giftCards.setBlocked(companyId, blocked!.id, false, actor, reason);
      await db.transaction((tx) =>
        c.giftCards.redeem(tx, {
          companyId,
          code: blocked!.code,
          amount: 10,
          orderId: 'o2',
          actor: 'x',
        }),
      );

      const [old] = await c.giftCards.issue(companyId, { funding: { kind: 'complimentary' }, value: 100 }, actor, reason);
      await db
        .update(schema.giftCards)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(schema.giftCards.id, old!.id));
      await expect(
        db.transaction((tx) =>
          c.giftCards.redeem(tx, {
            companyId,
            code: old!.code,
            amount: 10,
            orderId: 'o3',
            actor: 'x',
          }),
        ),
      ).rejects.toThrow(/expired/);
      await expect(
        db.transaction((tx) =>
          c.giftCards.redeem(tx, {
            companyId,
            code: blocked!.code,
            amount: 500,
            orderId: 'o4',
            actor: 'x',
          }),
        ),
      ).rejects.toThrow(/only 90.00 left/);
    });

    it('lists and searches', async () => {
      const [card] = await c.giftCards.issue(
        companyId,
        { funding: { kind: 'complimentary' }, value: 25, note: `find-${randomUUID().slice(0, 6)}` },
        actor,
        reason,
      );
      const hit = await c.giftCards.list(companyId, card!.note!);
      expect(hit.map((x) => x.id)).toContain(card!.id);
    });
  });

  // ── Paying orders ────────────────────────────────────────────────────────

  describe('paying an order with a gift card and points', () => {
    const staff = { type: 'user' as const, id: 'p4-cashier' };
    const loyaltyOn = () =>
      c.loyalty.saveProgram(
        companyId,
        {
          name: 'Tender loyalty',
          status: 'active',
          config: {
            pointsPer100: 1,
            pointValue: 1,
            minRedeemPoints: 1,
            maxRedeemPercent: 50,
            expiryMonths: null,
            tiers: [],
          },
        },
        actor,
        reason,
      );

    it('a card covering part of an order leaves the rest for a gateway', async () => {
      const cust = await customer();
      const prod = await product({ price: '1000', stockQuantity: 50 });
      const res = await order(cust.email!, [[prod, 1]]);
      const [card] = await c.giftCards.issue(companyId, { funding: { kind: 'complimentary' }, value: 300 }, actor, reason);
      const out = await c.tenders.apply(
        companyId,
        res.order!.id,
        { giftCards: [{ code: card!.code }] },
        staff,
      );
      expect(out).toMatchObject({ tendered: 300, due: 700, paid: false });
      const o = await orderRow(res.order!.id);
      expect(o).toMatchObject({
        paymentStatus: 'unpaid',
        totalAmount: '1000.00',
        tenderedAmount: '300.00',
      });
      const { amountDue } = await import('@/server/domains/orders/amount-due');
      expect(amountDue({ totalAmount: 1000, tenderedAmount: 300 })).toBe(700);
      expect((await c.giftCards.lookup(companyId, card!.code)).balance).toBe(0);
    });

    it('covering the whole order pays it, takes the stock, and records the tender', async () => {
      const cust = await customer();
      const prod = await product({ price: '200', stockQuantity: 10 });
      const res = await order(cust.email!, [[prod, 2]]);
      expect((await prodRow(prod)).reservedQuantity).toBe(2);
      const [card] = await c.giftCards.issue(companyId, { funding: { kind: 'complimentary' }, value: 1000 }, actor, reason);
      const out = await c.tenders.apply(
        companyId,
        res.order!.id,
        { giftCards: [{ code: card!.code }] },
        staff,
      );
      expect(out).toMatchObject({ tendered: 400, due: 0, paid: true });
      expect(out.warning).toBeUndefined();
      const o = await orderRow(res.order!.id);
      expect(o).toMatchObject({
        paymentStatus: 'paid',
        status: 'processing',
        transactionReference: `TENDER-${o.orderNumber}`,
      });
      const p = await prodRow(prod);
      expect(p.reservedQuantity).toBe(0);
      expect(p.stockQuantity).toBe(8);
      expect((await c.giftCards.lookup(companyId, card!.code)).balance).toBe(600);
      const tenders = await db
        .select()
        .from(schema.orderTenders)
        .where(eq(schema.orderTenders.orderId, res.order!.id));
      expect(tenders.map((t) => [t.kind, t.amount])).toEqual([['gift_card', '400.00']]);
    });

    it('points and cards combine, points first and limited to their share of the order', async () => {
      await loyaltyOn();
      const cust = await customer();
      await c.loyalty.adjust(companyId, cust.id, 1000, 'seed', actor, reason);
      const prod = await product({ price: '1000' });
      const res = await order(cust.email!, [[prod, 1]]);
      const [card] = await c.giftCards.issue(companyId, { funding: { kind: 'complimentary' }, value: 400 }, actor, reason);
      const out = await c.tenders.apply(
        companyId,
        res.order!.id,
        { loyaltyPoints: 'all', giftCards: [{ code: card!.code }] },
        staff,
      );
      // Points cover at most half (500); the card covers the rest.
      expect(out.applied.map((a) => [a.kind, a.amount])).toEqual([
        ['loyalty_points', 500],
        ['gift_card', 400],
      ]);
      expect(out).toMatchObject({ due: 100, paid: false });
      expect((await c.loyalty.account(companyId, cust.id)).balance).toBe(500 + 0 + 10 - 0); // seed 1000 - 500 spent + 10 earned
    });

    it('cancelling gives the card, the points and the earned points back', async () => {
      await loyaltyOn();
      const cust = await customer();
      await c.loyalty.adjust(companyId, cust.id, 400, 'seed', actor, reason);
      const prod = await product({ price: '1000' });
      const res = await order(cust.email!, [[prod, 1]]);
      const [card] = await c.giftCards.issue(companyId, { funding: { kind: 'complimentary' }, value: 300 }, actor, reason);
      await c.tenders.apply(
        companyId,
        res.order!.id,
        { loyaltyPoints: 200, giftCards: [{ code: card!.code }] },
        staff,
      );
      expect((await c.giftCards.lookup(companyId, card!.code)).balance).toBe(0);
      expect((await c.loyalty.account(companyId, cust.id)).balance).toBe(400 - 200 + 10);
      await cancel(res.order!.id);
      expect((await c.giftCards.lookup(companyId, card!.code)).balance).toBe(300);
      expect((await c.loyalty.account(companyId, cust.id)).balance).toBe(400);
      await cancel(res.order!.id);
      expect((await c.giftCards.lookup(companyId, card!.code)).balance).toBe(300);
      expect((await c.loyalty.account(companyId, cust.id)).balance).toBe(400);
    });

    it('is refused for a paid order, an unknown card, an order on account, and an empty request', async () => {
      const cust = await customer();
      const prod = await product({ price: '100' });
      const res = await order(cust.email!, [[prod, 1]]);
      const [card] = await c.giftCards.issue(companyId, { funding: { kind: 'complimentary' }, value: 500 }, actor, reason);
      await c.tenders.apply(companyId, res.order!.id, { giftCards: [{ code: card!.code }] }, staff);
      await expect(
        c.tenders.apply(companyId, res.order!.id, { giftCards: [{ code: card!.code }] }, staff),
      ).rejects.toThrow(/already paid/);
      const res2 = await order(cust.email!, [[prod, 1]]);
      await expect(
        c.tenders.apply(
          companyId,
          res2.order!.id,
          { giftCards: [{ code: 'AAAA-BBBB-CCCC-DDDD' }] },
          staff,
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(c.tenders.apply(companyId, res2.order!.id, {}, staff)).rejects.toMatchObject({
        code: 'INVALID',
      });
      await expect(
        c.tenders.apply(companyId, 'ord_missing', { giftCards: [{ code: card!.code }] }, staff),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('a failed tender leaves nothing spent', async () => {
      const cust = await customer();
      const prod = await product({ price: '100' });
      const res = await order(cust.email!, [[prod, 1]]);
      const [good] = await c.giftCards.issue(companyId, { funding: { kind: 'complimentary' }, value: 30 }, actor, reason);
      // The second card does not exist: the first card's spend must roll back with it.
      await expect(
        c.tenders.apply(
          companyId,
          res.order!.id,
          { giftCards: [{ code: good!.code }, { code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ' }] },
          staff,
        ),
      ).rejects.toThrow();
      expect((await c.giftCards.lookup(companyId, good!.code)).balance).toBe(30);
      expect(Number((await orderRow(res.order!.id)).tenderedAmount)).toBe(0);
    });

    it('two cashiers using the same card on two orders cannot overspend it', async () => {
      const cust = await customer();
      const prod = await product({ price: '100' });
      // The orders are made one after the other: the race under test is the two tenders below.
      const a = await order(cust.email!, [[prod, 1]]);
      const b = await order(cust.email!, [[prod, 1]]);
      expect(a.order, 'first order was not created').toBeDefined();
      expect(b.order, 'second order was not created').toBeDefined();
      const [card] = await c.giftCards.issue(companyId, { funding: { kind: 'complimentary' }, value: 100 }, actor, reason);
      const results = await Promise.allSettled([
        c.tenders.apply(companyId, a.order!.id, { giftCards: [{ code: card!.code }] }, staff),
        c.tenders.apply(companyId, b.order!.id, { giftCards: [{ code: card!.code }] }, staff),
      ]);
      const paid = [
        (await orderRow(a.order!.id)).tenderedAmount,
        (await orderRow(b.order!.id)).tenderedAmount,
      ].map(Number);
      expect(paid.reduce((n, x) => n + x, 0)).toBe(100);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((await c.giftCards.lookup(companyId, card!.code)).balance).toBe(0);
    });
  });

  it('leaves the shared loyalty programme paused', async () => {
    await c.loyalty.saveProgram(
      companyId,
      {
        name: 'Test loyalty',
        status: 'paused',
        config: {
          pointsPer100: 1,
          pointValue: 1,
          minRedeemPoints: 1,
          maxRedeemPercent: 100,
          expiryMonths: null,
          tiers: [],
        },
      },
      actor,
      reason,
    );
    expect((await c.loyalty.program(companyId))?.status).toBe('paused');
  });
});
