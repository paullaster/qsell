import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { getContainer } from '@/server/di/container';
import type { drizzleDb } from '@/server/db/drizzle/client';
import type * as schemaModule from '@/server/db/drizzle/schema';
import { parseCount } from '../shifts/shift-rules';
import type { OfflineSale } from './offline-rules';
import { signSale } from './offline-sale-service';

/**
 * Offline selling (database): the setting and its limits, a till's snapshot and key, a sale taken in at the price the customer paid, a sale
 * changed after it was signed, a sale past a limit, a sale whose stock is not there (kept, then made once the stock is put right), a sale
 * into a closed shift, and a repeat that changes nothing.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (url !== undefined && url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === undefined || url === '')('offline selling (database)', () => {
  let c: ReturnType<typeof getContainer>;
  let db: typeof drizzleDb;
  let schema: typeof schemaModule;
  let companyId: string;
  let branchId: string;
  let itemTypeId: string;
  let cashMethod = '';
  const actor = { type: 'user' as const, id: 'offline-test' };
  const reason = { code: 'POLICY_CHANGE' };
  const limits = { maxPerShift: 50_000, maxHours: 24 };

  const user = async (name: string) => {
    const [row] = await db.insert(schema.users).values({ email: `${name}-${randomUUID().slice(0, 8)}@of.test`, passwordHash: 'x', name, role: 'manager' }).returning();
    if (row === undefined) throw new Error('no user');
    return row;
  };
  const counted = (total: number) => {
    const r = parseCount({ total }, 'cash');
    if (!r.ok) throw new Error(r.error);
    return r;
  };
  const shiftFor = async (person: { id: string }) => {
    const name = `OL till ${randomUUID().slice(0, 6)}`;
    await c.shifts.saveRegister(companyId, actor, { branchId, name, isActive: true }, reason);
    const till = (await c.shifts.registerList(companyId)).find((r) => r.name === name);
    const opened = await c.shifts.open(companyId, { userId: person.id, branchId: null }, { registerId: till?.id ?? '', float: counted(0) });
    if (!opened.ok) throw new Error(opened.error);
    return opened.shiftId;
  };
  const tea = async (price = 100, stock = 100) => {
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({ id, sku: `OL-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `OLS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: `Offline tea ${randomUUID().slice(0, 5)}`, slug: `ol-${randomUUID()}`, itemTypeId, price: String(price), costPrice: '10', taxRate: '0', isTaxInclusive: true, stockQuantity: stock });
    return id;
  };
  const stockOf = async (id: string) => (await db.select({ s: schema.products.stockQuantity }).from(schema.products).where(eq(schema.products.id, id)))[0]?.s ?? -1;
  /** A sale as a till would sign it with the key it was given. */
  const rung = async (person: { id: string }, shiftId: string, over: { productId: string; quantity?: number; unitPrice?: number; deviceTime?: string; tender?: number }): Promise<OfflineSale & { signature: string }> => {
    const snap = await c.offlineSales.snapshot(companyId, person.id);
    if (!snap.ok) throw new Error(snap.error);
    const quantity = over.quantity ?? 1;
    const unitPrice = over.unitPrice ?? 100;
    const total = Math.round(quantity * unitPrice * 100) / 100;
    const sale: OfflineSale = { key: randomUUID(), shiftId, deviceRef: `OFF-T1-${String(Math.floor(Math.random() * 9000) + 1000)}`, deviceTime: over.deviceTime ?? new Date().toISOString(), lines: [{ productId: over.productId, quantity, unitPrice }], tenders: [{ methodId: cashMethod, amount: over.tender ?? total, reference: '' }], total };
    return { ...sale, signature: signSale(snap.data.secret, sale) };
  };

  beforeAll(async () => {
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    itemTypeId = `it_ol_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    const { branch } = await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Offline Co');
    branchId = ((await c.branches.getDefault(companyId)) ?? branch).id;
    const [existing] = await db.select({ id: schema.paymentProviderConfigs.id }).from(schema.paymentProviderConfigs).limit(1);
    const provider = existing ?? (await db.insert(schema.paymentProviderConfigs).values({ companyId, providerCode: 'manual', displayName: 'Manual', isSystem: true, isEnabled: true, apiBaseUrl: 'https://manual.invalid', environment: 'sandbox' } as never).returning({ id: schema.paymentProviderConfigs.id }))[0];
    const run = randomUUID().slice(0, 6).toUpperCase();
    const [bank] = await db.insert(schema.bankAccounts).values({ companyId, code: `OLC${run}`, name: `Offline cash ${run}`, kind: 'cash', currency: 'KES', createdBy: 'test' } as never).returning();
    const [gl] = await db.insert(schema.glAccounts).values({ companyId, no: `16${run}`, name: `Offline cash ${run}`, type: 'posting', category: 'assets', normalBalance: 'debit' } as never).returning();
    const [method] = await db.insert(schema.paymentMethods).values({ companyId, providerId: provider?.id ?? '', code: `OLC${run}`, name: `Offline cash ${run}`, kind: 'cash', balancingBankAccountId: bank?.id ?? '', glAccountId: gl?.id ?? '', usableFor: ['customer_receipt'], createdBy: 'test' } as never).returning();
    cashMethod = method?.id ?? '';
  });

  it('is off until switched on with a reason that is recorded, and checks the limits it is given', async () => {
    await db.delete(schema.offlineSellingSettings).where(eq(schema.offlineSellingSettings.companyId, companyId));
    expect((await c.offlineSales.settings(companyId)).enabled).toBe(false);
    const person = await user('off');
    await shiftFor(person);
    expect(await c.offlineSales.snapshot(companyId, person.id)).toEqual({ ok: false, error: 'Offline selling is switched off.' });
    await expect(c.offlineSales.saveSettings(companyId, actor, { enabled: true, limits: { maxPerShift: 0, maxHours: 24 } }, reason)).rejects.toThrow('from 1 to 10,000,000');
    await expect(c.offlineSales.saveSettings(companyId, actor, { enabled: true, limits }, { code: 'NO_SUCH' })).rejects.toThrow();
    await c.offlineSales.saveSettings(companyId, actor, { enabled: true, limits }, reason);
    expect(await c.offlineSales.settings(companyId)).toMatchObject({ enabled: true, limits });
    expect((await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectType, 'offline_selling_settings'))).length).toBeGreaterThan(0);
  });

  it('gives a till what it needs while online: the shift\'s key, the limits, what it may sell and be paid with, and only what is offered at the counter', async () => {
    const person = await user('snap');
    const shiftId = await shiftFor(person);
    const offered = await tea();
    const hidden = await tea();
    await db.update(schema.products).set({ offeredIn: ['quote'] }).where(eq(schema.products.id, hidden));
    const snap = await c.offlineSales.snapshot(companyId, person.id);
    if (!snap.ok) throw new Error(snap.error);
    expect(snap.data).toMatchObject({ shiftId, limits, soldSoFar: 0 });
    expect(snap.data.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(snap.data.products.map((p) => p.id)).toContain(offered);
    expect(snap.data.products.map((p) => p.id)).not.toContain(hidden);
    expect(snap.data.methods.map((m) => m.id)).toContain(cashMethod);
    const again = await c.offlineSales.snapshot(companyId, person.id);
    expect(again.ok && again.data.secret).toBe(snap.data.secret);
    expect(await c.offlineSales.snapshot(companyId, (await user('noshift')).id)).toMatchObject({ ok: false });
  });

  it('takes a sale in at the price the customer paid, flags a price that is not today\'s, makes the receipt, and a repeat changes nothing', async () => {
    const person = await user('accept');
    const shiftId = await shiftFor(person);
    const product = await tea(100);
    const same = await rung(person, shiftId, { productId: product, quantity: 2, unitPrice: 100, tender: 500 });
    const got = await c.offlineSales.ingest(companyId, { userId: person.id }, same);
    expect(got).toMatchObject({ ok: true, status: 'accepted', flags: [] });
    expect(got.ok && got.status === 'accepted' ? got.receiptNumber : '').toMatch(/^RCT-/);
    expect(await stockOf(product)).toBe(98);
    const [order] = await db.select().from(schema.orders).where(eq(schema.orders.idempotencyKey, same.key));
    expect(order).toMatchObject({ salesModule: 'pos_cash_sale', paymentStatus: 'paid', shiftId, totalAmount: '200.00' });
    expect(await c.offlineSales.ingest(companyId, { userId: person.id }, same)).toEqual(got);
    expect(await stockOf(product)).toBe(98);
    // Sold at 90 while the price is 100: accepted at what was paid, and flagged for a person to look at.
    const cheaper = await rung(person, shiftId, { productId: product, quantity: 1, unitPrice: 90, tender: 100 });
    const flagged = await c.offlineSales.ingest(companyId, { userId: person.id }, cheaper);
    expect(flagged).toMatchObject({ ok: true, status: 'needs_review', flags: ['price_differs'] });
    const [cheapOrder] = await db.select().from(schema.orders).where(eq(schema.orders.idempotencyKey, cheaper.key));
    expect(cheapOrder?.totalAmount).toBe('90.00');
    expect((await c.offlineSales.review(companyId)).some((r) => r.saleKey === cheaper.key && r.status === 'needs_review')).toBe(true);
    const row = (await db.select().from(schema.offlineSales).where(eq(schema.offlineSales.saleKey, cheaper.key)))[0];
    expect(await c.offlineSales.acknowledge(companyId, actor, row?.id ?? '')).toEqual({ ok: true });
    expect((await c.offlineSales.review(companyId)).some((r) => r.saleKey === cheaper.key)).toBe(false);
  });

  it('refuses a sale changed after it was signed, a sale from another person\'s shift, and a sale into a closed shift, keeping each as it came', async () => {
    const person = await user('tamper');
    const stranger = await user('stranger');
    const shiftId = await shiftFor(person);
    const product = await tea();
    const sale = await rung(person, shiftId, { productId: product, quantity: 1, unitPrice: 100 });
    const changed = { ...sale, lines: [{ ...sale.lines[0], unitPrice: 1 }], total: 1, tenders: [{ ...sale.tenders[0], amount: 1 }] };
    const refused = await c.offlineSales.ingest(companyId, { userId: person.id }, changed);
    expect(refused).toMatchObject({ ok: true, status: 'rejected' });
    expect(refused.ok && refused.status === 'rejected' ? refused.reason : '').toContain('changed after it was rung up');
    expect(await c.offlineSales.ingest(companyId, { userId: stranger.id }, sale)).toEqual({ ok: false, error: 'This sale is not from one of your shifts.' });
    const [kept] = await db.select().from(schema.offlineSales).where(eq(schema.offlineSales.saleKey, changed.key));
    expect(kept?.status).toBe('rejected');
    // A shift that was closed before the sale arrived takes no more.
    const late = await rung(person, shiftId, { productId: product });
    expect((await c.shifts.close(companyId, { userId: person.id, supervisor: false }, shiftId, { declared: counted(0), reason: '' })).ok).toBe(true);
    const closed = await c.offlineSales.ingest(companyId, { userId: person.id }, late);
    expect(closed.ok && closed.status === 'rejected' ? closed.reason : '').toContain('already closed');
    expect(await stockOf(product)).toBe(100);
  });

  it('refuses a sale past the shift\'s limit or one that waited too long', async () => {
    await c.offlineSales.saveSettings(companyId, actor, { enabled: true, limits: { maxPerShift: 250, maxHours: 24 } }, reason);
    try {
      const person = await user('limits');
      const shiftId = await shiftFor(person);
      const product = await tea();
      const first = await c.offlineSales.ingest(companyId, { userId: person.id }, await rung(person, shiftId, { productId: product, quantity: 2 }));
      expect(first).toMatchObject({ ok: true, status: 'accepted' });
      const over = await c.offlineSales.ingest(companyId, { userId: person.id }, await rung(person, shiftId, { productId: product, quantity: 1 }));
      expect(over.ok && over.status === 'rejected' ? over.reason : '').toContain('most allowed is 250');
      const old = await c.offlineSales.ingest(companyId, { userId: person.id }, await rung(person, shiftId, { productId: product, quantity: 0.5, deviceTime: new Date(Date.now() - 3 * 86_400_000).toISOString() }));
      expect(old.ok && old.status === 'rejected' ? old.reason : '').toContain('more than 24 hours');
    } finally {
      await c.offlineSales.saveSettings(companyId, actor, { enabled: true, limits }, reason);
    }
  });

  it('keeps a sale whose stock is not there, stops the shift being closed until it is dealt with, and makes it once the stock is put right', async () => {
    const person = await user('parked');
    const shiftId = await shiftFor(person);
    const product = await tea(100, 1);
    const sale = await rung(person, shiftId, { productId: product, quantity: 5 });
    const parked = await c.offlineSales.ingest(companyId, { userId: person.id }, sale);
    expect(parked).toMatchObject({ ok: true, status: 'parked' });
    expect(parked.ok && parked.status === 'parked' ? parked.reason : '').toContain('Insufficient inventory');
    expect(await stockOf(product)).toBe(1);
    const closing = await c.shifts.close(companyId, { userId: person.id, supervisor: false }, shiftId, { declared: counted(0), reason: '' });
    expect(closing.ok ? '' : closing.error).toContain('offline sale(s)');
    await db.update(schema.products).set({ stockQuantity: 10 }).where(eq(schema.products.id, product));
    const [row] = await db.select().from(schema.offlineSales).where(eq(schema.offlineSales.saleKey, sale.key));
    expect(await c.offlineSales.retryParked(companyId, row?.id ?? '')).toMatchObject({ ok: true, status: 'accepted' });
    expect(await stockOf(product)).toBe(5);
    expect(await c.offlineSales.parkedIn(shiftId)).toBe(0);
    expect((await c.shifts.close(companyId, { userId: person.id, supervisor: false }, shiftId, { declared: counted(500), reason: '' })).ok).toBe(true);
  });

  it('lets a person give a parked sale up with a reason, and never changes or deletes one that was received', async () => {
    const person = await user('discard');
    const shiftId = await shiftFor(person);
    const product = await tea(100, 0);
    const sale = await rung(person, shiftId, { productId: product, quantity: 1 });
    await c.offlineSales.ingest(companyId, { userId: person.id }, sale);
    const [row] = await db.select().from(schema.offlineSales).where(eq(schema.offlineSales.saleKey, sale.key));
    expect(row?.status).toBe('parked');
    expect(await c.offlineSales.discard(companyId, actor, row?.id ?? '', 'x')).toEqual({ ok: false, error: 'Say why, in 3 to 200 characters.' });
    expect(await c.offlineSales.discard(companyId, actor, row?.id ?? '', 'the goods were never given')).toEqual({ ok: true });
    expect((await db.select().from(schema.offlineSales).where(eq(schema.offlineSales.id, row?.id ?? '')))[0]).toMatchObject({ status: 'discarded' });
    await expect(db.update(schema.offlineSales).set({ total: '1.00' }).where(eq(schema.offlineSales.id, row?.id ?? ''))).rejects.toThrow();
    await expect(db.delete(schema.offlineSales).where(eq(schema.offlineSales.id, row?.id ?? ''))).rejects.toThrow();
  });
});
