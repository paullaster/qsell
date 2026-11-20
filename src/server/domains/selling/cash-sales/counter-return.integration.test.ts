import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { getContainer } from '@/server/di/container';
import type { drizzleDb } from '@/server/db/drizzle/client';
import type * as schemaModule from '@/server/db/drizzle/schema';
import { parseCount } from '../shifts/shift-rules';

/**
 * Returns at the till against a real database, with the finance chart set up (a credit note posts to the books and the refund goes
 * through the refund flow). It sets up finance for the company, so run it on a database of its own, not together with the other
 * selling tests:  TEST_DATABASE_URL=postgres://... pnpm exec vitest run src/server/domains/selling/cash-sales/counter-return
 */
const url = process.env.TEST_DATABASE_URL;
if (url !== undefined && url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === undefined || url === '')('returns at the till (database)', () => {
  let c: ReturnType<typeof getContainer>;
  let db: typeof drizzleDb;
  let schema: typeof schemaModule;
  let companyId: string;
  let branchId: string;
  let itemTypeId: string;
  let cashMethod = '';
  const actor = { type: 'user' as const, id: 'counter-return-test' };
  const reason = { code: 'POLICY_CHANGE' };

  const user = async (name: string) => {
    const [row] = await db.insert(schema.users).values({ email: `${name}-${randomUUID().slice(0, 8)}@cr.test`, passwordHash: 'x', name, role: 'manager' }).returning();
    if (row === undefined) throw new Error('no user');
    return row;
  };
  const counted = (total: number) => {
    const r = parseCount({ total }, 'cash');
    if (!r.ok) throw new Error(r.error);
    return r;
  };
  const shiftFor = async (person: { id: string }, float = 0) => {
    const name = `CR till ${randomUUID().slice(0, 6)}`;
    await c.shifts.saveRegister(companyId, actor, { branchId, name, isActive: true }, reason);
    const till = (await c.shifts.registerList(companyId)).find((r) => r.name === name);
    const opened = await c.shifts.open(companyId, { userId: person.id, branchId: null }, { registerId: till?.id ?? '', float: counted(float) });
    if (!opened.ok) throw new Error(opened.error);
    return opened.shiftId;
  };
  const tea = async () => {
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({ id, sku: `CR-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `CRS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: 'Return tea', slug: `cr-${randomUUID()}`, itemTypeId, price: '100', costPrice: '10', taxRate: '0', isTaxInclusive: true, stockQuantity: 100 });
    return id;
  };
  const stockOf = async (id: string) => (await db.select({ stock: schema.products.stockQuantity }).from(schema.products).where(eq(schema.products.id, id)))[0]?.stock ?? -1;
  const sell = async (person: { id: string }, productId: string, quantity: number) => {
    const sold = await c.cashSales.complete(companyId, { userId: person.id, branchId: null }, { customerId: null, lines: [{ productId, quantity }], tenders: [{ methodId: cashMethod, amount: quantity * 100, reference: '' }], saleKey: randomUUID() });
    if (!sold.ok) throw new Error(sold.error);
    return sold.sale;
  };
  const giveBack = async (person: { id: string }, orderId: string, productId: string, quantity: number, extra: { restock?: boolean; key?: string } = {}) =>
    await c.counterReturns.run(companyId, { userId: person.id }, { orderId, lines: [{ productId, quantity }], reason: { code: 'POLICY_CHANGE', text: 'customer changed their mind' }, restock: extra.restock ?? true, refund: { methodId: cashMethod, phone: '' }, key: extra.key ?? randomUUID() });

  beforeAll(async () => {
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    itemTypeId = `it_cr_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    const { branch } = await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Returns Co');
    branchId = ((await c.branches.getDefault(companyId)) ?? branch).id;
    const ctx = { companyId, actor, origin: { surface: 'test', action: 'setup' } };
    // A second run on the same database finds the chart already there.
    await c.finance.setup.applyTemplate(ctx, 'kenya', { fiscalYearStart: '2026-01-01' }).catch((error: unknown) => {
      if (!(error instanceof Error) || !error.message.includes('already has a chart')) throw error;
    });
    await c.finance.paymentMethods.seedStandard(ctx).catch(() => undefined);
    const [cash] = await db.select().from(schema.paymentMethods).where(and(eq(schema.paymentMethods.companyId, companyId), eq(schema.paymentMethods.kind, 'cash'), eq(schema.paymentMethods.enabled, true))).limit(1);
    if (cash === undefined) throw new Error('no cash method');
    cashMethod = cash.id;
    await db.update(schema.paymentMethods).set({ usableFor: ['customer_receipt', 'customer_refund'], refundDestination: 'manual' }).where(eq(schema.paymentMethods.id, cashMethod));
  });

  it('returns a whole sale: a credit note, the goods back in stock, and the cash handed back from the open shift', async () => {
    const person = await user('returner');
    const shiftId = await shiftFor(person);
    const product = await tea();
    const sale = await sell(person, product, 2);
    expect(await stockOf(product)).toBe(98);
    const result = await giveBack(person, sale.orderId, product, 2);
    expect(result.ok ? 'ok' : result.error).toBe('ok');
    if (!result.ok) return;
    expect(result.ret).toMatchObject({ amount: 200, restock: true, stockBack: true, status: 'completed', cashPaid: 200, refundStatus: 'paid', next: null });
    expect(result.ret.creditNoteNo).not.toBe('');
    expect(await stockOf(product)).toBe(100);
    const report = await c.shifts.report(companyId, shiftId);
    expect(report).toMatchObject({ cashSales: 200, expectedCash: 0, takings: { cash: 200, refunds: 1, cashRefunds: 200 } });
    expect(await c.counterReturns.returnable(companyId, sale.orderId)).toEqual({ ok: false, error: 'Everything on this sale has already been returned.' });
  });

  it('returns part of a sale, keeps the rest returnable, and leaves damaged goods out of stock', async () => {
    const person = await user('partial');
    await shiftFor(person);
    const product = await tea();
    const sale = await sell(person, product, 5);
    const first = await giveBack(person, sale.orderId, product, 2, { restock: false });
    expect(first.ok && first.ret).toMatchObject({ amount: 200, restock: false, stockBack: false, status: 'completed' });
    expect(await stockOf(product)).toBe(95);
    const left = await c.counterReturns.returnable(companyId, sale.orderId);
    expect(left.ok && left.lines[0]?.remainingQuantity).toBe(3);
    const second = await giveBack(person, sale.orderId, product, 4);
    expect(second.ok ? '' : second.error).toContain('at most 3');
    expect((await giveBack(person, sale.orderId, product, 3)).ok).toBe(true);
    expect(await stockOf(product)).toBe(98);
  });

  it('counts nothing twice when the same return is sent again', async () => {
    const person = await user('repeat');
    const shiftId = await shiftFor(person);
    const product = await tea();
    const sale = await sell(person, product, 3);
    const key = randomUUID();
    const first = await giveBack(person, sale.orderId, product, 1, { key });
    const again = await giveBack(person, sale.orderId, product, 1, { key });
    expect([first.ok ? 'ok' : first.error, again.ok ? 'ok' : again.error]).toEqual(['ok', 'ok']);
    expect(first.ok && again.ok ? again.ret.returnId : '').toBe(first.ok ? first.ret.returnId : 'x');
    expect(await stockOf(product)).toBe(98);
    expect((await c.shifts.report(companyId, shiftId))?.takings).toMatchObject({ refunds: 1, cashRefunds: 100 });
    const other = await user('thief');
    await shiftFor(other);
    expect(await giveBack(other, sale.orderId, product, 1, { key })).toEqual({ ok: false, error: 'This return could not be told apart from another. Start it again.' });
  });

  it('needs an open shift to hand cash back, and credits nothing without one', async () => {
    const person = await user('noshift');
    const seller = await user('seller');
    await shiftFor(seller);
    const product = await tea();
    const sale = await sell(seller, product, 1);
    const refused = await giveBack(person, sale.orderId, product, 1);
    expect(refused).toEqual({ ok: false, error: 'Open a shift on a till before selling at the counter.' });
    expect((await c.counterReturns.returnable(companyId, sale.orderId)).ok).toBe(true);
  });

  it('refuses what is not a return: an unknown sale, a sale that is not a counter sale, a way of paying that cannot refund, no lines', async () => {
    const person = await user('refuser');
    await shiftFor(person);
    const product = await tea();
    const sale = await sell(person, product, 1);
    expect((await giveBack(person, 'ord_nope', product, 1)).ok).toBe(false);
    expect(await c.counterReturns.run(companyId, { userId: person.id }, { orderId: sale.orderId, lines: [], reason: { code: 'POLICY_CHANGE', text: 'x' }, restock: true, refund: { methodId: cashMethod, phone: '' }, key: randomUUID() })).toEqual({ ok: false, error: 'Choose what is being returned.' });
    const noMethod = await c.counterReturns.run(companyId, { userId: person.id }, { orderId: sale.orderId, lines: [{ productId: product, quantity: 1 }], reason: { code: 'POLICY_CHANGE', text: 'x' }, restock: true, refund: { methodId: randomUUID(), phone: '' }, key: randomUUID() });
    expect(noMethod.ok ? '' : noMethod.error).toContain('Choose how the customer is paid back');
    expect(await c.counterReturns.run(companyId, { userId: person.id }, { orderId: sale.orderId, lines: [{ productId: product, quantity: 1 }], reason: { code: 'NO_SUCH_REASON', text: 'x' }, restock: true, refund: { methodId: cashMethod, phone: '' }, key: randomUUID() })).toMatchObject({ ok: false });
    expect(await stockOf(product)).toBe(99);
  });

  it('never hands cash back from a closed shift: the database refuses it', async () => {
    const person = await user('sealed');
    const shiftId = await shiftFor(person);
    const product = await tea();
    const sale = await sell(person, product, 1);
    const result = await giveBack(person, sale.orderId, product, 1);
    expect(result.ok).toBe(true);
    // 100 sold, 100 handed back: the till should hold nothing, so it closes right.
    const closed = await c.shifts.close(companyId, { userId: person.id, supervisor: false }, shiftId, { declared: counted(0), reason: '' });
    expect(closed.ok ? 'ok' : closed.error).toBe('ok');
    const [row] = await db.select().from(schema.counterReturns).where(eq(schema.counterReturns.orderId, sale.orderId));
    await expect(db.update(schema.counterReturns).set({ cashPaid: '50.00' }).where(eq(schema.counterReturns.id, row?.id ?? ''))).rejects.toThrow();
    await expect(db.delete(schema.counterReturns).where(eq(schema.counterReturns.id, row?.id ?? ''))).rejects.toThrow();
  });
});
