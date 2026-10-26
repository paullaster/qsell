import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { has, isRecord, readText, required } from '@/lib/values';
import { emptyBusiness, emptyFinancial, emptyProfile, type ProfileData } from '@/lib/vendor-profile';
import { emptyCategory } from '@/lib/prequalification';
import { emptyPoHeader, emptyPoLine, type PoLineForm } from '@/lib/purchase-order';
import type { RgnHeaderForm, RgnLineForm } from '@/lib/rgn';
import type { LandedCostForm } from '@/lib/landed-cost';
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

describe.skipIf(!has(url))('landed costs (database)', () => {
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

  async function approvedVendor(): Promise<PortalActor> {
    seq += 1;
    const [u] = await db.insert(schema.users).values({ email: `lc${String(seq)}.${run}@example.test`, passwordHash: 'x', name: 'Owner', role: 'vendor' }).returning();
    const vendorId = await c.vendors.registerBusiness({ companyId, userId: required(u).id, legalName: `LC Vendor ${run} ${String(seq)}`, email: `lc${String(seq)}.${run}@example.test`, phone: null });
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
    const itemTypeId = `itl_${run}_${String(prodSeq)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({ id, sku: `LC-${run}-${String(prodSeq)}`.toUpperCase(), stockCode: `LCS-${run}-${String(prodSeq)}`.toUpperCase(), name: `Receiving ${String(prodSeq)}`, slug: `lc-${randomUUID()}`, itemTypeId, price: '999', costPrice: cost, stockQuantity: stock });
    return id;
  }

  /** A sent order with the lines given, for a qualified vendor; returns the order and its line ids. */
  async function sentOrder(v: PortalActor, lines: PoLineForm[], over: { currency?: string; confirm?: boolean } = {}) {
    catSeq += 1;
    const cat = await c.categories.save(companyId, null, { ...emptyCategory(), code: `LC${String(catSeq)}_${run}`.toUpperCase(), name: `LC category ${String(catSeq)} ${run}` });
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
  const dn = () => `DN-LC-${run}-${String(++seq)}`;
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
      .values({ legalName: 'LC', tradingName: 'LC', email: 'buyer@lc.test', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P' })
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



  beforeAll(async () => {
    await db.update(schema.financeSettings).set({ inventoryGlGoLive: '2026-01-01' }).where(eq(schema.financeSettings.companyId, companyId));
  });

  const form = (over: Partial<LandedCostForm> = {}): LandedCostForm => ({ kind: 'freight', description: 'Sea freight', reference: `FR-${run}-${String(++seq)}`, amount: '1000', method: 'value', ...over });
  const costOf = async (productId: string) => required((await db.select().from(schema.products).where(eq(schema.products.id, productId)))[0]).costPrice;
  async function received(lines: { qty: string; price: string }[]) {
    const v = await approvedVendor();
    const prods: string[] = [];
    for (const _l of lines) prods.push(await product(0, '1'));
    const order = await sentOrder(v, lines.map((l, i) => stockLine(required(prods[i]), { quantity: l.qty, unitPrice: l.price, discountPercent: '0', description: `Item ${String(i + 1)}` })));
    const got = await receive(order.id, order.lines.map((id, i) => rl(id, required(lines[i]).qty)));
    return { prods, rgnId: got.id, number: got.number };
  }

  it('spreads a charge over the stock lines by value, adds it to what they cost, and is posted by another person', async () => {
    const r = await received([{ qty: '10', price: '100' }, { qty: '10', price: '300' }]);
    expect(await costOf(required(r.prods[0]))).toBe('100.00');
    const draft = await c.landedCosts.saveDraft(staff('clerk'), null, r.rgnId, form({ amount: '2000' }));
    const preview = required(await c.landedCosts.get(companyId, draft.id)).preview;
    expect(preview?.map((p) => p.share)).toEqual(['500.00', '1500.00']);
    expect(await codeOf(c.landedCosts.post(staff('clerk'), draft.id))).toBe('FOUR_EYES');
    const out = await c.landedCosts.post(staff('boss'), draft.id);
    expect(out.number).toMatch(/^LCA-\d{4}-\d{5}$/);
    expect(await costOf(required(r.prods[0]))).toBe('150.00');
    expect(await costOf(required(r.prods[1]))).toBe('450.00');
    expect(out.capitalisedCents).toBe(200_000);
    const done = required(await c.landedCosts.get(companyId, draft.id));
    expect(done.cost.status).toBe('posted');
    expect(done.lines.map((l) => [l.costBefore, l.costAfter, l.capitalised])).toEqual([['100.00', '150.00', '500.00'], ['300.00', '450.00', '1500.00']]);
    expect(await codeOf(c.landedCosts.post(staff('boss'), draft.id))).toBe('NOT_DRAFT');
    expect(await codeOf(db.update(schema.landedCosts).set({ amount: '1.00' }).where(eq(schema.landedCosts.id, draft.id)))).toBe('23001');
    expect(await codeOf(db.delete(schema.landedCosts).where(eq(schema.landedCosts.id, draft.id)))).toBe('23001');
    // The same charge on the same note is entered once.
    expect(await codeOf(c.landedCosts.saveDraft(staff('clerk'), null, r.rgnId, form({ reference: done.cost.reference.toUpperCase() })))).toBe('DUPLICATE');
  });

  it('can spread by quantity, refuses a draft that is wrong, and can be cancelled with a reason', async () => {
    const r = await received([{ qty: '10', price: '100' }, { qty: '30', price: '100' }]);
    expect(await codeOf(c.landedCosts.saveDraft(staff('clerk'), null, r.rgnId, form({ amount: '0' })))).toBe('INVALID');
    expect(await codeOf(c.landedCosts.saveDraft(staff('clerk'), null, randomUUID(), form()))).toBe('NOT_POSTED');
    const d = await c.landedCosts.saveDraft(staff('clerk'), null, r.rgnId, form({ amount: '400', method: 'quantity' }));
    expect(required(await c.landedCosts.get(companyId, d.id)).preview?.map((p) => p.share)).toEqual(['100.00', '300.00']);
    expect(await codeOf(c.landedCosts.cancel(staff('clerk'), d.id, ' '))).toBe('NOTE_REQUIRED');
    await c.landedCosts.cancel(staff('clerk'), d.id, 'Wrong note');
    expect(await codeOf(c.landedCosts.post(staff('boss'), d.id))).toBe('NOT_DRAFT');
    const e = await c.landedCosts.saveDraft(staff('clerk'), null, r.rgnId, form({ amount: '400', method: 'quantity' }));
    await c.landedCosts.post(staff('boss'), e.id);
    expect(await costOf(required(r.prods[0]))).toBe('110.00');
    expect(await costOf(required(r.prods[1]))).toBe('110.00');
    expect((await c.landedCosts.list(companyId, { rgnId: r.rgnId })).map((x) => x.status).sort()).toEqual(['cancelled', 'posted']);
  });

  it('is refused when part of the goods has been sold, and the books follow the cost change', async () => {
    const r = await received([{ qty: '10', price: '100' }]);
    const d = await c.landedCosts.saveDraft(staff('clerk'), null, r.rgnId, form({ amount: '500' }));
    await db.update(schema.products).set({ stockQuantity: 6 }).where(eq(schema.products.id, required(r.prods[0])));
    expect(await codeOf(c.landedCosts.post(staff('boss'), d.id))).toBe('GOODS_SOLD');
    expect(await costOf(required(r.prods[0]))).toBe('100.00');
    await db.update(schema.products).set({ stockQuantity: 10 }).where(eq(schema.products.id, required(r.prods[0])));
    await c.landedCosts.post(staff('boss'), d.id);
    const events = await db.select().from(schema.financeInventoryEvents).where(eq(schema.financeInventoryEvents.productId, required(r.prods[0])));
    const revaluation = events.find((e) => e.kind === 'revaluation');
    expect(revaluation?.changeType).toBe('cost_change');
    expect(Number(revaluation?.value)).toBe(500);
  });
});
