import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { getContainer } from '@/server/di/container';
import type { drizzleDb } from '@/server/db/drizzle/client';
import type * as schemaModule from '@/server/db/drizzle/schema';
import { parseCount } from '../shifts/shift-rules';

/**
 * Counter sales against a real database: a sale only into the person's own open shift, paid in cash (with change), M-Pesa or card, one
 * or several ways, the payment checked before anything is held, a receipt on the POS series, stock out, the shift's takings, a retry that
 * counts nothing twice, and a closed shift that takes no more cash.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (url !== undefined && url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === undefined || url === '')('counter sales (database)', () => {
  let c: ReturnType<typeof getContainer>;
  let db: typeof drizzleDb;
  let schema: typeof schemaModule;
  let companyId: string;
  let branchId: string;
  let itemTypeId: string;
  const actor = { type: 'user' as const, id: 'cash-sale-test' };
  const reason = { code: 'POLICY_CHANGE' };
  const methods: Record<'cash' | 'mobile_money' | 'card', string> = { cash: '', mobile_money: '', card: '' };

  const user = async (name: string) => {
    const [row] = await db.insert(schema.users).values({ email: `${name}-${randomUUID().slice(0, 8)}@cs.test`, passwordHash: 'x', name, role: 'manager' }).returning();
    if (row === undefined) throw new Error('no user');
    return row;
  };
  const counted = (total: number) => {
    const r = parseCount({ total }, 'cash');
    if (!r.ok) throw new Error(r.error);
    return r;
  };
  const shiftFor = async (person: { id: string }, float = 1000) => {
    const name = `CS till ${randomUUID().slice(0, 6)}`;
    await c.shifts.saveRegister(companyId, actor, { branchId, name, isActive: true }, reason);
    const till = (await c.shifts.registerList(companyId)).find((r) => r.name === name);
    const opened = await c.shifts.open(companyId, { userId: person.id, branchId: null }, { registerId: till?.id ?? '', float: counted(float) });
    if (!opened.ok) throw new Error(opened.error);
    return opened.shiftId;
  };
  /** A tea at 100 (tax included, no VAT), 100 in stock. */
  const tea = async (price = 100) => {
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({ id, sku: `CS-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `CSS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: 'Counter tea', slug: `cs-${randomUUID()}`, itemTypeId, price: String(price), costPrice: '10', taxRate: '0', isTaxInclusive: true, stockQuantity: 100 });
    return id;
  };
  const stockOf = async (id: string) => {
    const [row] = await db.select({ stock: schema.products.stockQuantity, reserved: schema.products.reservedQuantity }).from(schema.products).where(eq(schema.products.id, id));
    return { stock: row?.stock ?? 0, reserved: row?.reserved ?? 0 };
  };
  const sell = async (person: { id: string }, productId: string, quantity: number, tenders: { kind: 'cash' | 'mobile_money' | 'card'; amount: number; reference?: string }[], extra: { saleKey?: string; customerId?: string | null } = {}) =>
    await c.cashSales.complete(companyId, { userId: person.id, branchId: null }, { customerId: extra.customerId ?? null, lines: [{ productId, quantity }], tenders: tenders.map((t) => ({ methodId: methods[t.kind], amount: t.amount, reference: t.reference ?? '' })), saleKey: extra.saleKey ?? randomUUID() });

  beforeAll(async () => {
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    itemTypeId = `it_cs_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    const { branch } = await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Cash Sales Co');
    branchId = ((await c.branches.getDefault(companyId)) ?? branch).id;
    // A way of paying for each kind the counter takes, each into its own account.
    const [existing] = await db.select({ id: schema.paymentProviderConfigs.id }).from(schema.paymentProviderConfigs).limit(1);
    const provider = existing ?? (await db.insert(schema.paymentProviderConfigs).values({ companyId, providerCode: 'manual', displayName: 'Manual', isSystem: true, isEnabled: true, apiBaseUrl: 'https://manual.invalid', environment: 'sandbox' } as never).returning({ id: schema.paymentProviderConfigs.id }))[0];
    for (const kind of ['cash', 'mobile_money', 'card'] as const) {
      const run = randomUUID().slice(0, 6).toUpperCase();
      const [bank] = await db.insert(schema.bankAccounts).values({ companyId, code: `CS${kind.slice(0, 1).toUpperCase()}${run}`, name: `Counter ${kind} ${run}`, kind: kind === 'cash' ? 'cash' : 'bank', currency: 'KES', createdBy: 'test' } as never).returning();
      const [gl] = await db.insert(schema.glAccounts).values({ companyId, no: `19${kind.length}${run}`, name: `Counter ${kind} ${run}`, type: 'posting', category: 'assets', normalBalance: 'debit' } as never).returning();
      const [method] = await db.insert(schema.paymentMethods).values({ companyId, providerId: provider?.id ?? '', code: `CS${kind.slice(0, 1).toUpperCase()}${run}`, name: `Counter ${kind} ${run}`, kind, balancingBankAccountId: bank?.id ?? '', glAccountId: gl?.id ?? '', usableFor: ['customer_receipt'], requiresReference: kind !== 'cash', createdBy: 'test' } as never).returning();
      methods[kind] = method?.id ?? '';
    }
  });

  it('rings up a cash sale in the person\'s open shift: change given, the receipt on the POS series, stock out, the till takes the cash', async () => {
    const person = await user('cashier');
    const shiftId = await shiftFor(person, 1000);
    const product = await tea(100);
    const sold = await sell(person, product, 2, [{ kind: 'cash', amount: 500 }]);
    expect(sold.ok).toBe(true);
    if (!sold.ok) return;
    expect(sold.sale).toMatchObject({ total: 200, changeDue: 300, customerName: 'Walk-in customer' });
    expect(sold.sale.receiptNumber).toMatch(/^RCT-/);
    expect(sold.sale.tenders).toEqual([expect.objectContaining({ kind: 'cash', applied: 200, handedOver: 500 })]);
    const [order] = await db.select().from(schema.orders).where(eq(schema.orders.id, sold.sale.orderId));
    expect(order).toMatchObject({ salesModule: 'pos_cash_sale', paymentStatus: 'paid', shiftId, paymentMethod: 'counter', tradeCustomerId: await c.cashSales.walkIn(companyId) });
    expect(await stockOf(product)).toEqual({ stock: 98, reserved: 0 });
    const report = await c.shifts.report(companyId, shiftId);
    expect(report).toMatchObject({ cashSales: 200, expectedCash: 1200, takings: { count: 1, cash: 200, mobileMoney: 0, card: 0 } });
    const listed = await c.cashSales.list(companyId, { shiftId });
    expect(listed.rows.map((r) => r.orderNumber)).toEqual([sold.sale.orderNumber]);
  });

  it('refuses a payment that does not cover the sale before anything is held or saved', async () => {
    const person = await user('short');
    await shiftFor(person);
    const product = await tea(100);
    const key = randomUUID();
    const refused = await sell(person, product, 1, [{ kind: 'cash', amount: 90 }], { saleKey: key });
    expect(refused).toEqual({ ok: false, error: 'The cash is short: 10.00 more is needed.' });
    expect(await stockOf(product)).toEqual({ stock: 100, reserved: 0 });
    expect(await db.select().from(schema.orders).where(eq(schema.orders.idempotencyKey, key))).toEqual([]);
    expect((await sell(person, product, 1, [{ kind: 'mobile_money', amount: 200, reference: 'QWE1' }]))).toEqual({ ok: false, error: 'M-Pesa and card cannot be more than the sale: they cannot give change.' });
    const noReference = await sell(person, product, 1, [{ kind: 'mobile_money', amount: 100 }]);
    expect(noReference.ok ? '' : noReference.error).toContain('Enter the reference');
  });

  it('needs the person\'s own open shift: none, or one waiting for its close to be approved, refuses', async () => {
    const person = await user('noshift');
    const product = await tea(100);
    expect(await sell(person, product, 1, [{ kind: 'cash', amount: 200 }])).toEqual({ ok: false, error: 'Open a shift on a till before selling at the counter.' });
    const shiftId = await shiftFor(person);
    await db.update(schema.shifts).set({ status: 'closing' }).where(eq(schema.shifts.id, shiftId));
    const held = await sell(person, product, 1, [{ kind: 'cash', amount: 200 }]);
    expect(held.ok ? '' : held.error).toContain('waiting for its close');
    await db.update(schema.shifts).set({ status: 'open' }).where(eq(schema.shifts.id, shiftId));
    expect((await sell(person, product, 1, [{ kind: 'cash', amount: 200 }])).ok).toBe(true);
    expect(await stockOf(product)).toEqual({ stock: 99, reserved: 0 });
  });

  it('splits a sale between M-Pesa and cash: the exact way first, the cash covers the rest, each in its own total', async () => {
    const person = await user('splitter');
    const shiftId = await shiftFor(person, 0);
    const product = await tea(100);
    const sold = await sell(person, product, 10, [{ kind: 'mobile_money', amount: 800, reference: 'QXY123' }, { kind: 'cash', amount: 300 }]);
    expect(sold.ok).toBe(true);
    if (!sold.ok) return;
    expect(sold.sale).toMatchObject({ total: 1000, changeDue: 100 });
    expect(sold.sale.tenders.map((t) => [t.kind, t.applied, t.reference])).toEqual([['mobile_money', 800, 'QXY123'], ['cash', 200, null]]);
    expect(await c.shifts.report(companyId, shiftId)).toMatchObject({ cashSales: 200, takings: { count: 1, cash: 200, mobileMoney: 800, card: 0 } });
  });

  it('counts nothing twice when the same sale is sent again', async () => {
    const person = await user('retry');
    const shiftId = await shiftFor(person, 0);
    const product = await tea(100);
    const key = randomUUID();
    const first = await sell(person, product, 1, [{ kind: 'cash', amount: 200 }], { saleKey: key });
    const again = await sell(person, product, 1, [{ kind: 'cash', amount: 200 }], { saleKey: key });
    expect(first.ok && again.ok).toBe(true);
    expect(first.ok && again.ok ? again.sale.orderId : '').toBe(first.ok ? first.sale.orderId : 'x');
    expect(await stockOf(product)).toEqual({ stock: 99, reserved: 0 });
    expect((await c.shifts.report(companyId, shiftId))?.takings).toMatchObject({ count: 1, cash: 100 });
    // Another person cannot use that key to read or finish someone else's sale.
    const other = await user('thief');
    await shiftFor(other);
    expect(await sell(other, product, 1, [{ kind: 'cash', amount: 200 }], { saleKey: key })).toEqual({ ok: false, error: 'This sale could not be told apart from another. Start the sale again.' });
  });

  it('finishes a sale whose payment was not recorded, and the shift cannot be closed while one is waiting', async () => {
    const person = await user('unfinished');
    const shiftId = await shiftFor(person, 0);
    const product = await tea(100);
    const key = randomUUID();
    const placed = await c.salesOrders.place(companyId, { userId: person.id, branchId: null }, { customerId: await c.cashSales.walkIn(companyId), lines: [{ productId: product, quantity: 1 }], paymentMethod: 'counter', neededOn: '', holdUntilPaid: false }, 'pos_cash_sale', { shiftId, idempotencyKey: key });
    expect(placed.ok).toBe(true);
    const blocked = await c.shifts.close(companyId, { userId: person.id, supervisor: false }, shiftId, { declared: counted(0), reason: '' });
    expect(blocked.ok ? '' : blocked.error).toContain('waiting for their payment');
    const finished = await sell(person, product, 1, [{ kind: 'cash', amount: 120 }], { saleKey: key });
    expect(finished.ok).toBe(true);
    expect(finished.ok ? finished.sale.changeDue : -1).toBe(20);
    expect(await c.shifts.close(companyId, { userId: person.id, supervisor: false }, shiftId, { declared: counted(100), reason: '' })).toMatchObject({ ok: true, pending: false, variance: 0 });
  });

  it('keeps one walk-in customer for the company, and a named customer can be chosen instead', async () => {
    const person = await user('walker');
    await shiftFor(person);
    const product = await tea(100);
    const a = await c.cashSales.walkIn(companyId);
    expect(await c.cashSales.walkIn(companyId)).toBe(a);
    expect((await db.select().from(schema.customers).where(and(eq(schema.customers.companyId, companyId), eq(schema.customers.isWalkIn, true))))).toHaveLength(1);
    const [named] = await db.insert(schema.customers).values({ companyId, number: `CSC-${randomUUID().slice(0, 8)}`, name: 'Wanjiku Traders', email: `w-${randomUUID().slice(0, 6)}@cs.test`, accountType: 'cash' } as never).returning();
    const sold = await sell(person, product, 1, [{ kind: 'card', amount: 100, reference: '0042' }], { customerId: named?.id ?? '' });
    expect(sold.ok ? sold.sale.customerName : '').toBe('Wanjiku Traders');
  });

  it('never lets cash into a shift that is closed: the database refuses a sale or a tender in it', async () => {
    const person = await user('sealed');
    const shiftId = await shiftFor(person, 0);
    const product = await tea(100);
    const sold = await sell(person, product, 1, [{ kind: 'cash', amount: 100 }]);
    if (!sold.ok) throw new Error(sold.error);
    expect((await c.shifts.close(companyId, { userId: person.id, supervisor: false }, shiftId, { declared: counted(100), reason: '' })).ok).toBe(true);
    await expect(db.update(schema.orders).set({ shiftId }).where(eq(schema.orders.id, sold.sale.orderId))).resolves.toBeDefined();
    await expect(db.insert(schema.orderTenders).values({ orderId: sold.sale.orderId, kind: 'payment_method', reference: methods.cash, amount: '1.00', methodKind: 'cash', actor: 'x' })).rejects.toThrow();
    expect(await sell(person, product, 1, [{ kind: 'cash', amount: 200 }])).toEqual({ ok: false, error: 'Open a shift on a till before selling at the counter.' });
  });
});
