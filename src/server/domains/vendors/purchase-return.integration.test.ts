import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { has, isRecord, readText, required } from '@/lib/values';
import { emptyBusiness, emptyFinancial, emptyProfile, type ProfileData } from '@/lib/vendor-profile';
import { emptyCategory } from '@/lib/prequalification';
import { emptyPoHeader, emptyPoLine, type PoLineForm } from '@/lib/purchase-order';
import type { RgnHeaderForm, RgnLineForm } from '@/lib/rgn';
import type { ReturnHeaderForm, ReturnLineForm } from '@/lib/purchase-return';
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

describe.skipIf(!has(url))('purchase returns (database)', () => {
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
    const [u] = await db.insert(schema.users).values({ email: `pr${String(seq)}.${run}@example.test`, passwordHash: 'x', name: 'Owner', role: 'vendor' }).returning();
    const vendorId = await c.vendors.registerBusiness({ companyId, userId: required(u).id, legalName: `PR Vendor ${run} ${String(seq)}`, email: `pr${String(seq)}.${run}@example.test`, phone: null });
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
    const itemTypeId = `itp_${run}_${String(prodSeq)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({ id, sku: `PR-${run}-${String(prodSeq)}`.toUpperCase(), stockCode: `PRS-${run}-${String(prodSeq)}`.toUpperCase(), name: `Receiving ${String(prodSeq)}`, slug: `pr-${randomUUID()}`, itemTypeId, price: '999', costPrice: cost, stockQuantity: stock });
    return id;
  }

  const stockOf = async (id: string) => required((await db.select().from(schema.products).where(eq(schema.products.id, id)))[0]);

  /** A sent order with the lines given, for a qualified vendor; returns the order and its line ids. */
  async function sentOrder(v: PortalActor, lines: PoLineForm[], over: { currency?: string; confirm?: boolean } = {}) {
    catSeq += 1;
    const cat = await c.categories.save(companyId, null, { ...emptyCategory(), code: `PR${String(catSeq)}_${run}`.toUpperCase(), name: `PR category ${String(catSeq)} ${run}` });
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
  const dn = () => `DN-PR-${run}-${String(++seq)}`;
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
      .values({ legalName: 'PR', tradingName: 'PR', email: 'buyer@pr.test', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P' })
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


  const retHeader = (over: Partial<ReturnHeaderForm> = {}): ReturnHeaderForm => ({ returnDate: TODAY, reason: 'faulty', vendorReference: '', notes: '', ...over });
  const retLine = (rgnLineId: string, quantity: string): ReturnLineForm => ({ rgnLineId, quantity });
  async function received(qty = '10') {
    const v = await approvedVendor();
    const prod = await product(0, '10');
    const order = await sentOrder(v, [stockLine(prod, { quantity: qty, discountPercent: '0' })]);
    const got = await receive(order.id, [rl(required(order.lines[0]), qty)]);
    const [line] = await db.select().from(schema.rgnLines).where(eq(schema.rgnLines.rgnId, got.id));
    return { v, prod, order, rgnId: got.id, rgnLineId: required(line).id };
  }
  const poStatus = async (id: string) => required((await c.purchaseOrders.get(companyId, id))).po.status;

  it('takes returned goods out of stock at cost, lowers what is received on the order, and is posted by another person', async () => {
    const r = await received('10');
    expect(await stockOf(r.prod)).toMatchObject({ stockQuantity: 10 });
    const out = await c.purchaseReturns.saveDraft(staff('storeman'), null, r.rgnId, retHeader({ vendorReference: 'RMA-7' }), [retLine(r.rgnLineId, '4')]);
    expect(await codeOf(c.purchaseReturns.post(staff('storeman'), out.id))).toBe('FOUR_EYES');
    const posted = await c.purchaseReturns.post(staff('boss'), out.id);
    expect(posted.number).toMatch(/^PRT-\d{4}-\d{5}$/);
    expect(await stockOf(r.prod)).toMatchObject({ stockQuantity: 6 });
    const move = (await db.select().from(schema.inventoryMovements).where(eq(schema.inventoryMovements.productId, r.prod))).find((m) => m.changeType === 'purchase_return');
    expect(move).toMatchObject({ referenceId: posted.number, changeAmount: -4 });
    const po = required(await c.purchaseOrders.get(companyId, r.order.id));
    expect(po.lines[0]?.receivedQuantity).toBe('6.000');
    expect(po.po.status).toBe('partially_received');
    const line = required((await db.select().from(schema.rgnLines).where(eq(schema.rgnLines.id, r.rgnLineId)))[0]);
    expect(line.returnedQuantity).toBe('4.000');
    const detail = required(await c.purchaseReturns.get(companyId, out.id));
    expect(detail.ret.status).toBe('posted');
    expect(detail.lines[0]).toMatchObject({ quantity: '4.000' });
    expect(Number(detail.lines[0]?.unitCost)).toBe(100);
    expect(await codeOf(c.purchaseReturns.post(staff('boss'), out.id))).toBe('NOT_DRAFT');
    expect(await codeOf(db.update(schema.purchaseReturns).set({ reason: 'other' }).where(eq(schema.purchaseReturns.id, out.id)))).toBe('23001');
    expect(await codeOf(db.delete(schema.purchaseReturns).where(eq(schema.purchaseReturns.id, out.id)))).toBe('23001');
    // The note can no longer be reversed, and the rest can go back, which empties the order again.
    expect(await codeOf(c.rgns.reverse(staff('boss'), r.rgnId, 'Mistake'))).toBe('ALREADY_RETURNED');
    const rest = await c.purchaseReturns.saveDraft(staff('storeman'), null, r.rgnId, retHeader(), [retLine(r.rgnLineId, '6')]);
    await c.purchaseReturns.post(staff('boss'), rest.id);
    expect(await poStatus(r.order.id)).toBe('sent');
    expect(await stockOf(r.prod)).toMatchObject({ stockQuantity: 0 });
  });

  it('refuses more than can go back, counts what other drafts ask for, and a draft can be cancelled with a reason', async () => {
    const r = await received('10');
    expect(await codeOf(c.purchaseReturns.saveDraft(staff('storeman'), null, r.rgnId, retHeader(), [retLine(r.rgnLineId, '10.001')]))).toBe('INVALID');
    expect(await codeOf(c.purchaseReturns.saveDraft(staff('storeman'), null, r.rgnId, retHeader({ reason: '' }), [retLine(r.rgnLineId, '1')]))).toBe('INVALID');
    expect(await codeOf(c.purchaseReturns.saveDraft(staff('storeman'), null, r.rgnId, retHeader(), []))).toBe('INVALID');
    const first = await c.purchaseReturns.saveDraft(staff('storeman'), null, r.rgnId, retHeader(), [retLine(r.rgnLineId, '7')]);
    expect(await codeOf(c.purchaseReturns.saveDraft(staff('storeman'), null, r.rgnId, retHeader(), [retLine(r.rgnLineId, '4')]))).toBe('INVALID');
    expect(required(await c.purchaseReturns.returnable(companyId, r.rgnId)).lines[0]).toMatchObject({ room: 10, roomAfterDrafts: 3 });
    expect(await codeOf(c.purchaseReturns.cancelDraft(staff('storeman'), first.id, ' '))).toBe('NOTE_REQUIRED');
    await c.purchaseReturns.cancelDraft(staff('storeman'), first.id, 'Changed our mind');
    expect(await codeOf(c.purchaseReturns.post(staff('boss'), first.id))).toBe('NOT_DRAFT');
    expect(required(await c.purchaseReturns.returnable(companyId, r.rgnId)).lines[0]?.roomAfterDrafts).toBe(10);
    expect(await codeOf(c.purchaseReturns.saveDraft(staff('storeman'), null, randomUUID(), retHeader(), [retLine(r.rgnLineId, '1')]))).toBe('NOT_POSTED');
    // Sold stock cannot go back.
    await db.update(schema.products).set({ stockQuantity: 2 }).where(eq(schema.products.id, r.prod));
    const big = await c.purchaseReturns.saveDraft(staff('storeman'), null, r.rgnId, retHeader(), [retLine(r.rgnLineId, '5')]);
    expect(await codeOf(c.purchaseReturns.post(staff('boss'), big.id))).toBe('STOCK_GONE');
    expect((await c.purchaseReturns.list(companyId, { rgnId: r.rgnId })).map((x) => x.status).sort()).toEqual(['cancelled', 'draft']);
  });
});
