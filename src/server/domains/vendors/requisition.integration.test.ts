import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { has, isRecord, readText, required } from '@/lib/values';
import { emptyBusiness, emptyFinancial, emptyProfile, type ProfileData } from '@/lib/vendor-profile';
import { emptyCategory } from '@/lib/prequalification';
import { emptyRequisitionLine, type RequisitionHeaderForm, type RequisitionLineForm } from '@/lib/purchase-requisition';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import type * as mod_schema from '@/server/db/drizzle/schema';
import type { AppContainer } from '@/server/di/container';
import type { FinanceContext } from '@/server/domains/finance/errors';
import type { PortalActor } from './profile-service';

/** Needs a Postgres built from the migrations:  TEST_DATABASE_URL=postgres://... pnpm test */
const url = process.env.TEST_DATABASE_URL;

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

describe.skipIf(!has(url))('purchase requisitions (database)', () => {
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
    const [u] = await db.insert(schema.users).values({ email: `rq${String(seq)}.${run}@example.test`, passwordHash: 'x', name: 'Owner', role: 'vendor' }).returning();
    const vendorId = await c.vendors.registerBusiness({ companyId, userId: required(u).id, legalName: `RQ Vendor ${run} ${String(seq)}`, email: `rq${String(seq)}.${run}@example.test`, phone: null });
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
    const itemTypeId = `itq_${run}_${String(prodSeq)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({ id, sku: `RQ-${run}-${String(prodSeq)}`.toUpperCase(), stockCode: `RQS-${run}-${String(prodSeq)}`.toUpperCase(), name: `Receiving ${String(prodSeq)}`, slug: `rq-${randomUUID()}`, itemTypeId, price: '999', costPrice: cost, stockQuantity: stock });
    return id;
  }

  const noticed: string[][] = [];
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    ({ drizzleDb: db } = await import('@/server/db/drizzle/client'));
    schema = await import('@/server/db/drizzle/schema');
    const { getContainer } = await import('@/server/di/container');
    c = getContainer();
    // The service tells people through its notifier; here it is replaced by a recorder, so each test can see who was told what.
    const stub: Record<string, unknown> = {};
    for (const name of ['requisitionDecided']) stub[name] = (...args: unknown[]) => {
      noticed.push([name, ...args.map(String)]);
      return Promise.resolve();
    };
    (c.requisitions as unknown as { notify?: unknown }).notify = stub;
    const [company] = await db
      .insert(schema.companySettings)
      .values({ legalName: 'RQ', tradingName: 'RQ', email: 'buyer@rq.test', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P' })
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

  async function category() {
    catSeq += 1;
    const cat = await c.categories.save(companyId, null, { ...emptyCategory(), code: `RQ${String(catSeq)}_${run}`.toUpperCase(), name: `Requisition category ${String(catSeq)} ${run}` });
    await c.categories.setStatus(companyId, cat.id, 'open');
    return cat.id;
  }
  const reqHeader = (categoryId: string, over: Partial<RequisitionHeaderForm> = {}): RequisitionHeaderForm => ({ title: 'Office chairs', purpose: 'Eight new hires', categoryId, currency: 'KES', neededBy: '', ...over });
  const lineOf = (over: Partial<RequisitionLineForm> = {}): RequisitionLineForm => ({ ...emptyRequisitionLine(), description: 'Office chair', quantity: '8', unit: unit.code, estimatedUnitPrice: '4500', ...over });
  const row = async (id: string) => required((await db.select().from(schema.purchaseRequisitions).where(eq(schema.purchaseRequisitions.id, id)))[0]);
  async function approved(over: Partial<RequisitionHeaderForm> = {}) {
    const cat = await category();
    const { id } = await c.requisitions.saveDraft(staff('asker'), null, reqHeader(cat, over), [lineOf(), lineOf({ description: 'Desk lamp', quantity: '2.5', estimatedUnitPrice: '10.10' })]);
    await c.requisitions.submit(staff('asker'), id);
    await c.requisitions.approve(staff('boss'), id);
    return { id, cat };
  }

  it('is written, sent for approval and approved by another person, and a submitted one cannot be changed', async () => {
    const cat = await category();
    expect(await codeOf(c.requisitions.saveDraft(staff('asker'), null, reqHeader(cat, { title: 'x' }), [lineOf()]))).toBe('INVALID');
    expect(await codeOf(c.requisitions.saveDraft(staff('asker'), null, reqHeader(cat), []))).toBe('INVALID');
    expect(await codeOf(c.requisitions.saveDraft(staff('asker'), null, reqHeader(cat), [lineOf({ quantity: '0' })]))).toBe('INVALID');
    const { id } = await c.requisitions.saveDraft(staff('asker'), null, reqHeader(cat), [lineOf(), lineOf({ description: 'Desk lamp', quantity: '2.5', estimatedUnitPrice: '10.10' })]);
    expect((await row(id)).estimatedTotal).toBe('36025.25');
    expect(await codeOf(c.requisitions.saveDraft(staff('other'), id, reqHeader(cat), [lineOf()]))).toBe('NOT_YOURS');
    expect(await codeOf(c.requisitions.submit(staff('other'), id))).toBe('NOT_YOURS');
    const sent = await c.requisitions.submit(staff('asker'), id);
    expect(sent.number).toMatch(/^PRQ-\d{4}-\d{5}$/);
    expect(await codeOf(c.requisitions.approve(staff('asker'), id))).toBe('FOUR_EYES');
    expect(await codeOf(c.requisitions.saveDraft(staff('asker'), id, reqHeader(cat), [lineOf()]))).toBe('NOT_DRAFT');
    expect(await codeOf(db.update(schema.purchaseRequisitions).set({ title: 'Changed' }).where(eq(schema.purchaseRequisitions.id, id)))).toBe('23001');
    expect(await codeOf(db.delete(schema.purchaseRequisitionLines).where(eq(schema.purchaseRequisitionLines.requisitionId, id)))).toBe('23001');
    await c.requisitions.approve(staff('boss'), id);
    expect((await row(id)).status).toBe('approved');
    expect(noticed.find((n) => n[0] === 'requisitionDecided' && n[1] === 'asker' && n[2] === sent.number && n[4] === 'approved')).toBeDefined();
    expect(await codeOf(db.update(schema.purchaseRequisitions).set({ decidedBy: 'asker' }).where(eq(schema.purchaseRequisitions.id, id)))).toBe('23514');
    expect(required(await c.requisitions.get(companyId, id)).lines).toHaveLength(2);
  });

  it('can be sent back to be changed, refused with a reason, or cancelled', async () => {
    const cat = await category();
    const a = await c.requisitions.saveDraft(staff('asker'), null, reqHeader(cat), [lineOf()]);
    await c.requisitions.submit(staff('asker'), a.id);
    expect(await codeOf(c.requisitions.reject(staff('boss'), a.id, ' ', true))).toBe('NOTE_REQUIRED');
    await c.requisitions.reject(staff('boss'), a.id, 'Say how many desks too', true);
    expect(await row(a.id)).toMatchObject({ status: 'draft', rejectReason: 'Say how many desks too' });
    await c.requisitions.saveDraft(staff('asker'), a.id, reqHeader(cat), [lineOf(), lineOf({ description: 'Desk' })]);
    await c.requisitions.submit(staff('asker'), a.id);
    await c.requisitions.reject(staff('boss'), a.id, 'Not this quarter', false);
    expect((await row(a.id)).status).toBe('rejected');
    expect(noticed.filter((n) => n[0] === 'requisitionDecided' && n[4] === 'sent_back' && n[5] === 'Say how many desks too')).toHaveLength(1);
    expect(noticed.filter((n) => n[0] === 'requisitionDecided' && n[4] === 'refused' && n[5] === 'Not this quarter')).toHaveLength(1);
    expect(await codeOf(c.requisitions.cancel(staff('asker'), a.id, 'whatever'))).toBe('WRONG_STATE');
    const b = await c.requisitions.saveDraft(staff('asker'), null, reqHeader(cat), [lineOf()]);
    expect(await codeOf(c.requisitions.cancel(staff('other'), b.id, 'mine now'))).toBe('NOT_YOURS');
    await c.requisitions.cancel(staff('asker'), b.id, 'No longer needed');
    expect((await row(b.id)).status).toBe('cancelled');
    expect((await c.requisitions.list(companyId, { status: 'rejected' })).some((x) => x.id === a.id)).toBe(true);
  });

  it('becomes a request for quotation or an order draft with the same lines, once, and only when approved', async () => {
    const draft = await c.requisitions.saveDraft(staff('asker'), null, reqHeader(await category()), [lineOf()]);
    expect(await codeOf(c.requisitions.convertToRfq(staff('buyer'), draft.id, { deadline: '2999-01-01T10:00' }))).toBe('WRONG_STATE');
    const one = await approved();
    expect(await codeOf(c.requisitions.convertToRfq(staff('buyer'), one.id, { deadline: 'soon' }))).toBe('INVALID');
    expect((await row(one.id)).status).toBe('approved');
    const made = await c.requisitions.convertToRfq(staff('buyer'), one.id, { deadline: '2999-01-01T10:00' });
    const rfq = required((await db.select().from(schema.rfqs).where(eq(schema.rfqs.id, made.rfqId)))[0]);
    expect(rfq).toMatchObject({ status: 'draft', categoryId: one.cat, currency: 'KES' });
    expect(await db.select().from(schema.rfqLines).where(eq(schema.rfqLines.rfqId, made.rfqId))).toHaveLength(2);
    expect(await row(one.id)).toMatchObject({ status: 'converted', convertedType: 'rfq', convertedId: made.rfqId });
    expect(noticed.some((n) => n[0] === 'requisitionDecided' && n[4] === 'converted')).toBe(true);
    expect(await codeOf(c.requisitions.convertToRfq(staff('buyer'), one.id, { deadline: '2999-01-01T10:00' }))).toBe('WRONG_STATE');
    const two = await approved();
    const vendor = await approvedVendor();
    const order = await c.requisitions.convertToOrder(staff('buyer'), two.id, { vendorId: vendor.vendorId });
    const po = required(await c.purchaseOrders.get(companyId, order.orderId));
    expect(po.po).toMatchObject({ status: 'draft', vendorId: vendor.vendorId, categoryId: two.cat });
    expect(po.lines).toHaveLength(2);
    expect(await row(two.id)).toMatchObject({ status: 'converted', convertedType: 'purchase_order', convertedId: order.orderId });
    const three = await approved();
    expect(await codeOf(c.requisitions.convertToOrder(staff('buyer'), three.id, { vendorId: randomUUID() }))).not.toBe('OK');
    expect((await row(three.id)).status).toBe('approved');
  });
});
