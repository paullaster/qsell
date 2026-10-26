import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { has, isRecord, readText, required } from '@/lib/values';
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

describe.skipIf(!has(url))('vendor scorecards (database)', () => {
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
    const [u] = await db.insert(schema.users).values({ email: `sc${String(seq)}.${run}@example.test`, passwordHash: 'x', name: 'Owner', role: 'vendor' }).returning();
    const vendorId = await c.vendors.registerBusiness({ companyId, userId: required(u).id, legalName: `Score Vendor ${run} ${String(seq)}`, email: `sc${String(seq)}.${run}@example.test`, phone: null });
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
    const itemTypeId = `its_${run}_${String(prodSeq)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({ id, sku: `SC-${run}-${String(prodSeq)}`.toUpperCase(), stockCode: `SCS-${run}-${String(prodSeq)}`.toUpperCase(), name: `Receiving ${String(prodSeq)}`, slug: `sc-${randomUUID()}`, itemTypeId, price: '999', costPrice: cost, stockQuantity: stock });
    return id;
  }

  /** A sent order with the lines given, for a qualified vendor; returns the order and its line ids. */
  async function sentOrder(v: PortalActor, lines: PoLineForm[], over: { currency?: string; confirm?: boolean } = {}) {
    catSeq += 1;
    const cat = await c.categories.save(companyId, null, { ...emptyCategory(), code: `SC${String(catSeq)}_${run}`.toUpperCase(), name: `Score category ${String(catSeq)} ${run}` });
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
  const dn = () => `DN-SC-${run}-${String(++seq)}`;
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
      .values({ legalName: 'SC', tradingName: 'SC', email: 'buyer@sc.test', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P' })
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



  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'OK';
    } catch (e) {
      if (isRecord(e) && typeof e.code === 'string') return e.code;
      const cause = isRecord(e) && isRecord(e.cause) ? readText(e.cause.code) : '';
      return cause === '' ? `OTHER:${(e as Error).message}` : cause;
    }
  };
  const range = { from: '2000-01-01', to: '2999-12-31' };

  it('starts with the standard criteria, and a company can add and change its own', async () => {
    const fresh = await c.scorecards.criteria(companyId);
    expect(fresh.map((x) => x.code).sort()).toEqual(['accepted', 'invoice_accuracy', 'on_time', 'rfq_response', 'service']);
    expect(fresh.reduce((s, x) => s + x.weight, 0)).toBe(100);
    const mine = await c.scorecards.saveCriterion(staff('admin'), null, { name: 'Packaging', source: 'rating', weight: '10', active: true });
    expect(await codeOf(c.scorecards.saveCriterion(staff('admin'), null, { name: 'packaging', source: 'rating', weight: '10', active: true }))).toBe('DUPLICATE');
    expect(await codeOf(c.scorecards.saveCriterion(staff('admin'), null, { name: 'x', source: 'mood', weight: '0', active: true }))).toBe('INVALID');
    await c.scorecards.saveCriterion(staff('admin'), mine.id, { name: 'Packaging', source: 'rating', weight: '10', active: false });
    expect((await c.scorecards.criteria(companyId, false)).some((x) => x.id === mine.id)).toBe(false);
    expect(await codeOf(c.scorecards.saveCriterion(staff('admin'), randomUUID(), { name: 'Nothing', source: 'rating', weight: '5', active: true }))).toBe('NOT_FOUND');
  });

  it('weighs measures and ratings into one score, leaves a vendor with too little unscored and last, and keeps reviews', async () => {
    const criteria = await c.scorecards.criteria(companyId, false);
    const service = required(criteria.find((x) => x.code === 'service'));
    const good = await approvedVendor();
    const prod = await product(0, '10');
    const order = await sentOrder(good, [stockLine(prod, { quantity: '10' })]);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    await db.update(schema.purchaseOrders).set({ expectedDate: tomorrow }).where(eq(schema.purchaseOrders.id, order.id));
    await receive(order.id, [rl(required(order.lines[0]), '10')]);
    const thin = await approvedVendor();
    await c.scorecards.addReview(staff('buyer'), good.vendorId, { [service.id]: 4 }, 'Quick to answer');
    await c.scorecards.addReview(staff('buyer'), thin.vendorId, { [service.id]: 5 }, '');
    const card = await c.scorecards.scorecards(companyId, range);
    const a = required(card.lines.find((l) => l.vendorId === good.vendorId));
    // on time 100 (weight 30), accepted 100 (25), service 80 (20): 7100 / 75, the other two criteria have nothing behind them.
    expect(a).toMatchObject({ score: 94.7, coverage: 75, grade: { letter: 'A' } });
    const b = required(card.lines.find((l) => l.vendorId === thin.vendorId));
    expect(b).toMatchObject({ score: null, coverage: 20, grade: { letter: '–' } });
    expect(card.lines.findIndex((l) => l.vendorId === good.vendorId)).toBeLessThan(card.lines.findIndex((l) => l.vendorId === thin.vendorId));
    expect(await codeOf(c.scorecards.addReview(staff('buyer'), good.vendorId, { [service.id]: 6 }, ''))).toBe('INVALID');
    expect(await codeOf(c.scorecards.addReview(staff('buyer'), good.vendorId, { [randomUUID()]: 3 }, ''))).toBe('INVALID');
    expect(await codeOf(c.scorecards.addReview(staff('buyer'), good.vendorId, {}, ''))).toBe('INVALID');
    expect(await codeOf(c.scorecards.addReview(staff('buyer'), randomUUID(), { [service.id]: 3 }, ''))).toBe('NOT_FOUND');
    const mine = await c.scorecards.reviews(companyId, good.vendorId);
    expect(mine).toHaveLength(1);
    expect(await codeOf(db.update(schema.vendorReviews).set({ comment: 'Changed' }).where(eq(schema.vendorReviews.id, required(mine[0]).id)))).toBe('23001');
    expect(await codeOf(db.delete(schema.vendorReviewRatings).where(eq(schema.vendorReviewRatings.reviewId, required(mine[0]).id)))).toBe('23001');
  });
});
