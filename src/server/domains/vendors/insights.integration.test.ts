import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { has, required } from '@/lib/values';
import { emptyBusiness, emptyFinancial, emptyProfile, type ProfileData } from '@/lib/vendor-profile';
import { emptyCategory } from '@/lib/prequalification';
import { emptyPoHeader, emptyPoLine, type PoLineForm } from '@/lib/purchase-order';
import type { RgnHeaderForm, RgnLineForm } from '@/lib/rgn';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import type * as mod_schema from '@/server/db/drizzle/schema';
import type { AppContainer } from '@/server/di/container';
import type { FinanceContext } from '@/server/domains/finance/errors';
import type { PortalActor } from './profile-service';

/** Needs a Postgres built from the migrations:  TEST_DATABASE_URL=postgres://... pnpm test */
const url = process.env.TEST_DATABASE_URL;

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const TODAY = new Date().toISOString().slice(0, 10);
const NO = { maySkipRfq: false, mayOverrideQualification: false };

describe.skipIf(!has(url))('vendor reports (database)', () => {
  let db: DrizzleDb;
  let schema: typeof mod_schema;
  let c: AppContainer;
  let companyId: string;
  let unit: { code: string; name: string };
  const run = randomUUID().slice(0, 6);
  let seq = 0;
  let catSeq = 0;
  let prodSeq = 0;

  const staff = (id: string): FinanceContext => ({ companyId, actor: { type: 'user', id }, origin: { surface: 'test', action: 'run' } });
  async function approvedVendor(): Promise<PortalActor> {
    seq += 1;
    const [u] = await db.insert(schema.users).values({ email: `ir${String(seq)}.${run}@example.test`, passwordHash: 'x', name: 'Owner', role: 'vendor' }).returning();
    const vendorId = await c.vendors.registerBusiness({ companyId, userId: required(u).id, legalName: `Insight Vendor ${run} ${String(seq)}`, email: `ir${String(seq)}.${run}@example.test`, phone: null });
    const a: PortalActor = { vendorId, userId: required(u).id, portalRole: 'owner' };
    const p = c.vendorProfile;
    const profile: ProfileData = { ...emptyProfile(), country: 'Kenya', description: 'We supply solar panels and inverters to businesses.', physicalStreet: '1 Mombasa Road', physicalCity: 'Nairobi', phone: '+254 700 000 000' };
    await p.saveProfile(a, profile);
    await p.saveBusiness(a, { ...emptyBusiness(), registrationNo: 'CPR/2012/12345', registrationDate: '2012-03-04', taxId: `G${String(Date.now()).slice(-9)}${String(seq % 10)}` });
    await p.addDirector(a, { name: 'Wanjiru Kamau', idType: 'national_id', idNumber: '12345678', sharePercent: '100' });
    await p.addBank(a, { bankName: 'KCB', branch: 'Moi Avenue', accountName: 'Acme Ltd', accountNumber: `0123${String(seq).padStart(6, '0')}`, swift: '' });
    await p.saveFinancial(a, { ...emptyFinancial(), offeredPaymentTermDays: '30' });
    await p.saveContacts(a, [{ name: 'Wanjiru Kamau', role: 'management', email: `w${String(seq)}.${run}@acme.test`, phone: '0700000000', isPrimary: true }]);
    for (const type of (await p.documentTypes(companyId)).filter((t) => t.requiredForAll)) {
      await p.addDocument(a, companyId, { documentTypeId: type.id, originalName: `${type.code}.pdf`, data: PDF, issuedOn: '2026-01-01', expiresOn: type.needsExpiry ? '2031-01-01' : '' });
    }
    await p.submit(a, companyId);
    const docs = await db.select().from(schema.vendorDocuments).where(eq(schema.vendorDocuments.vendorId, vendorId));
    for (const d of docs) await c.vendorReview.verifyDocument(staff('reviewer'), d.id, 'valid', '');
    await c.vendorReview.approve(staff('reviewer'), vendorId);
    return a;
  }

  async function product(stock: number, cost: string): Promise<string> {
    prodSeq += 1;
    const itemTypeId = `iti_${run}_${String(prodSeq)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({ id, sku: `IR-${run}-${String(prodSeq)}`.toUpperCase(), stockCode: `IRS-${run}-${String(prodSeq)}`.toUpperCase(), name: `Receiving ${String(prodSeq)}`, slug: `ir-${randomUUID()}`, itemTypeId, price: '999', costPrice: cost, stockQuantity: stock });
    return id;
  }

  /** A sent order with the lines given, for a qualified vendor; returns the order and its line ids. */
  async function sentOrder(v: PortalActor, lines: PoLineForm[], over: { currency?: string; confirm?: boolean } = {}) {
    catSeq += 1;
    const cat = await c.categories.save(companyId, null, { ...emptyCategory(), code: `IR${String(catSeq)}_${run}`.toUpperCase(), name: `Insight category ${String(catSeq)} ${run}` });
    await c.categories.setStatus(companyId, cat.id, 'open');
    const { ids } = await c.prequal.apply(v, companyId, [cat.id], TODAY);
    await c.prequal.submit(v, required(ids[0]));
    await c.prequalReview.take(staff('evaluator'), required(ids[0]));
    await c.prequalReview.approve(staff('decider'), required(ids[0]), { maxOrderValue: '', note: '' }, TODAY);
    const { id } = await c.purchaseOrders.saveDraft(staff('buyer'), null, { ...emptyPoHeader(TODAY), vendorId: v.vendorId, categoryId: cat.id, currency: over.currency ?? 'KES', noRfqReason: 'Test' }, lines, false);
    await c.purchaseOrders.submit(staff('buyer'), id, NO);
    await c.purchaseOrders.approve(staff('boss'), id);
    await c.purchaseOrders.send(staff('buyer'), id);
    if (over.confirm === true) await c.purchaseOrders.recordConfirmation(staff('buyer'), id, 'Phone', new Date());
    const got = required(await c.purchaseOrders.get(companyId, id));
    return { id, lines: got.lines.map((l) => l.id), number: required(got.po.number) };
  }

  const stockLine = (productId: string, over: Partial<PoLineForm> = {}): PoLineForm => ({ ...emptyPoLine(), productId, description: 'Solar panel 450W', quantity: '10', unit: unit.code, unitPrice: '100', discountPercent: '10', taxRate: '16', ...over });
  const header = (dn: string, date = TODAY): RgnHeaderForm => ({ receivedDate: date, deliveryNoteNo: dn, vehicle: 'KDA 123A', notes: '' });
  const rl = (poLineId: string, delivered: string, rejected = '', rejectReason = ''): RgnLineForm => ({ poLineId, delivered, rejected, rejectReason });
  const dn = () => `DN-IR-${run}-${String(++seq)}`;
  const receive = async (poId: string, lines: RgnLineForm[], note = dn()) => {
    const { id } = await c.rgns.saveDraft(staff('storeman'), null, poId, header(note), lines);
    return { id, ...(await c.rgns.post(staff('storeman'), id)) };
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    ({ drizzleDb: db } = await import('@/server/db/drizzle/client'));
    schema = await import('@/server/db/drizzle/schema');
    const { getContainer } = await import('@/server/di/container');
    c = getContainer();
    const [company] = await db
      .insert(schema.companySettings)
      .values({ legalName: 'IR', tradingName: 'IR', email: 'buyer@ir.test', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P' })
      .returning();
    companyId = required(company).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    await c.finance.setup.applyTemplate(staff('reviewer'), 'kenya', { fiscalYearStart: '2026-01-01' });
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    const probe = await product(0, '1');
    const [p] = await db.select({ unitId: schema.products.baseUnitId }).from(schema.products).where(eq(schema.products.id, probe));
    const [u] = await db.select({ code: schema.unitsOfMeasure.code, name: schema.unitsOfMeasure.name }).from(schema.unitsOfMeasure).where(eq(schema.unitsOfMeasure.id, required(p).unitId));
    unit = required(u);
  });


  const orderTotal = async (id: string) => Math.round(required(await c.purchaseOrders.get(companyId, id)).lines.reduce((s, l) => s + Number(l.lineTotal), 0) * 100);
  const range = { from: '2000-01-01', to: '2999-12-31' };

  it('commitments follow orders from ordered, to received, to still open, and stay inside the company', async () => {
    const v = await approvedVendor();
    const order = await sentOrder(v, [stockLine(await product(0, '10'))]);
    const total = await orderTotal(order.id);
    const line = async () => required((await c.vendorInsights.commitments(companyId)).lines.find((l) => l.vendorId === v.vendorId));
    expect(await line()).toMatchObject({ orders: 1, orderedCents: total, receivedCents: 0, invoicedCents: 0, openCents: total, receivedNotInvoicedCents: 0 });
    await receive(order.id, [rl(required(order.lines[0]), '4')]);
    expect(await line()).toMatchObject({ orderedCents: total, receivedCents: total * 0.4, openCents: total, receivedNotInvoicedCents: total * 0.4 });
    const all = await c.vendorInsights.commitments(companyId);
    expect(all.totals.orderedCents).toBeGreaterThanOrEqual(total);
    expect((await c.vendorInsights.commitments(randomUUID())).lines).toEqual([]);
    await c.purchaseOrders.cancel(staff('buyer'), order.id, 'No longer needed').catch(() => undefined);
  });

  it('performance counts deliveries on time and goods refused, and says "not measured" when nothing was', async () => {
    const v = await approvedVendor();
    const prod = await product(0, '10');
    const late = await sentOrder(v, [stockLine(prod, { quantity: '10' })]);
    const early = await sentOrder(v, [stockLine(prod, { quantity: '10' })]);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    await db.update(schema.purchaseOrders).set({ expectedDate: yesterday }).where(eq(schema.purchaseOrders.id, late.id));
    await db.update(schema.purchaseOrders).set({ expectedDate: tomorrow }).where(eq(schema.purchaseOrders.id, early.id));
    await receive(late.id, [rl(required(late.lines[0]), '10', '2', 'damaged')]);
    await receive(early.id, [rl(required(early.lines[0]), '10')]);
    const quiet = await approvedVendor();
    const report = await c.vendorInsights.performance(companyId, range);
    expect(report.lines.find((l) => l.vendorId === v.vendorId)).toMatchObject({ deliveries: 2, onTimePercent: 50, rejectedPercent: 10, invoiceLines: 0, accuratePercent: null, invited: 0, respondedPercent: null });
    expect(report.lines.find((l) => l.vendorId === quiet.vendorId)).toBeUndefined();
    expect((await c.vendorInsights.performance(companyId, { from: '2000-01-01', to: '2000-01-02' })).lines).toEqual([]);
  });

  it('purchases and the watch list read without error, and the watch list names shared bank accounts and orders raised with a rule set aside', async () => {
    const a = await approvedVendor();
    const b = await approvedVendor();
    const order = await sentOrder(a, [stockLine(await product(0, '10'))]);
    const [first] = await db.select().from(schema.vendorBankAccounts).where(eq(schema.vendorBankAccounts.vendorId, a.vendorId));
    await db.update(schema.vendorBankAccounts).set({ accountHash: required(first).accountHash }).where(eq(schema.vendorBankAccounts.vendorId, b.vendorId));
    const purchases = await c.vendorInsights.purchases(companyId, range);
    expect(purchases.range).toEqual(range);
    expect(typeof purchases.totalCents).toBe('number');
    const watch = await c.vendorInsights.watchList(companyId, range);
    expect(watch.sharedBankAccounts.some((s) => s.vendors.length === 2)).toBe(true);
    expect(watch.overriddenOrders.find((o) => o.number === order.number)).toMatchObject({ reason: 'Test' });
    expect(Array.isArray(watch.duplicateInvoices)).toBe(true);
    expect(Array.isArray(watch.newVendorPayments)).toBe(true);
    const other = await c.vendorInsights.watchList(randomUUID(), range);
    expect([other.sharedBankAccounts, other.overriddenOrders, other.duplicateInvoices, other.newVendorPayments].map((x) => x.length)).toEqual([0, 0, 0, 0]);
  });

  it('keeps its thresholds in the company settings, and the other reports read cleanly', async () => {
    expect(await c.vendorInsights.watchSettings(randomUUID())).toMatchObject({ duplicateWindowDays: 7, newVendorDays: 30, newVendorAmountCents: 10_000_000, holdFlagged: true });
    await c.purchaseOrders.saveSettings(staff('admin'), { rfqRequiredAbove: '', amendmentTolerancePercent: '0', watchDuplicateWindowDays: '3', watchNewVendorDays: '10', watchNewVendorAmount: '2500.50', holdFlaggedPayments: false });
    expect(await c.vendorInsights.watchSettings(companyId)).toEqual({ duplicateWindowDays: 3, newVendorDays: 10, newVendorAmountCents: 250_050, holdFlagged: false });
    expect((await c.vendorInsights.watchList(companyId, range)).settings.newVendorDays).toBe(10);
    await c.purchaseOrders.saveSettings(staff('admin'), { rfqRequiredAbove: '', amendmentTolerancePercent: '0', watchDuplicateWindowDays: '7', watchNewVendorDays: '30', watchNewVendorAmount: '100000', holdFlaggedPayments: true });
    const sourcing = await c.vendorInsights.sourcing(companyId, range);
    expect(sourcing.range).toEqual(range);
    expect(Array.isArray((await c.vendorInsights.withholding(companyId, range)).lines)).toBe(true);
    expect(Array.isArray((await c.vendorInsights.qualification(companyId)).lines)).toBe(true);
    const petty = await c.vendorInsights.pettyCash(companyId, range);
    expect(petty.lines).toEqual([]);
    expect((await c.vendorInsights.sourcing(randomUUID(), range)).lines).toEqual([]);
  });
});
