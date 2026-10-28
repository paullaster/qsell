import { businessDate } from '@/server/kernel/numbering/business-date';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';

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
const TODAY = businessDate();
const NO = { maySkipRfq: false, mayOverrideQualification: false };

describe.skipIf(!has(url))('received goods notes (database)', () => {
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
    const [u] = await db.insert(schema.users).values({ email: `rg${String(seq)}.${run}@example.test`, passwordHash: 'x', name: 'Owner', role: 'vendor' }).returning();
    const vendorId = await c.vendors.registerBusiness({ companyId, userId: required(u).id, legalName: `RGN Vendor ${run} ${String(seq)}`, email: `rg${String(seq)}.${run}@example.test`, phone: null });
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
    const itemTypeId = `it_${run}_${String(prodSeq)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({ id, sku: `RG-${run}-${String(prodSeq)}`.toUpperCase(), stockCode: `RGS-${run}-${String(prodSeq)}`.toUpperCase(), name: `Receiving ${String(prodSeq)}`, slug: `rg-${randomUUID()}`, itemTypeId, price: '999', costPrice: cost, stockQuantity: stock });
    return id;
  }

  const stockOf = async (id: string) => required((await db.select().from(schema.products).where(eq(schema.products.id, id)))[0]);

  /** A sent order with the lines given, for a qualified vendor; returns the order and its line ids. */
  async function sentOrder(v: PortalActor, lines: PoLineForm[], over: { currency?: string; confirm?: boolean } = {}) {
    catSeq += 1;
    const cat = await c.categories.save(companyId, null, { ...emptyCategory(), code: `RG${String(catSeq)}_${run}`.toUpperCase(), name: `RGN category ${String(catSeq)} ${run}` });
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
  const dn = () => `DN-${run}-${String(++seq)}`;
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
      .values({ legalName: 'RG', tradingName: 'RG', email: 'buyer@rg.test', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P' })
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

  describe('receiving', () => {
    it('puts accepted stock in at the order’s net cost, raises the order’s counters, and moves the order along', async () => {
      const v = await approvedVendor();
      const prod = await product(5, '50');
      const order = await sentOrder(v, [stockLine(prod)]);
      const out = await c.rgns.outstanding(companyId, order.id);
      expect(out.lines[0]).toMatchObject({ toCome: '10', mostAcceptable: '10' });
      const first = await receive(order.id, [rl(required(order.lines[0]), '4')]);
      expect(first.number).toMatch(/^RGN-\d{4}-\d{5}$/);
      expect(await stockOf(prod)).toMatchObject({ stockQuantity: 9, costPrice: '90.00' });
      const moves = await db.select().from(schema.inventoryMovements).where(eq(schema.inventoryMovements.productId, prod));
      expect(moves.find((m) => m.changeType === 'purchase_order_receipt')).toMatchObject({ referenceId: first.number, changeAmount: 4 });
      let po = required(await c.purchaseOrders.get(companyId, order.id));
      expect(po.po.status).toBe('partially_received');
      expect(po.lines[0]?.receivedQuantity).toBe('4.000');
      await receive(order.id, [rl(required(order.lines[0]), '6')]);
      po = required(await c.purchaseOrders.get(companyId, order.id));
      expect(po.po.status).toBe('received');
      expect((await stockOf(prod)).stockQuantity).toBe(15);
      expect(po.events.map((e) => e.event)).toEqual(expect.arrayContaining(['goods_received']));
      expect(await codeOf(c.rgns.saveDraft(staff('storeman'), null, order.id, header(dn()), [rl(required(order.lines[0]), '1')]))).toBe('NOT_RECEIVABLE');
    });

    it('does not put refused goods into stock, and asks why they were refused', async () => {
      const v = await approvedVendor();
      const prod = await product(0, '10');
      const order = await sentOrder(v, [stockLine(prod, { discountPercent: '0' })]);
      const line = required(order.lines[0]);
      expect(await codeOf(c.rgns.saveDraft(staff('storeman'), null, order.id, header(dn()), [rl(line, '10', '3', '')]))).toBe('INVALID');
      expect(await codeOf(c.rgns.saveDraft(staff('storeman'), null, order.id, header(dn()), [rl(line, '10', '11', 'damaged')]))).toBe('INVALID');
      await receive(order.id, [rl(line, '10', '3', 'damaged')]);
      expect((await stockOf(prod)).stockQuantity).toBe(7);
      const po = required(await c.purchaseOrders.get(companyId, order.id));
      expect(po.lines[0]?.receivedQuantity).toBe('7.000');
      expect(po.po.status).toBe('partially_received');
    });

    it('refuses more than ordered beyond the tolerance, and accepts it within', async () => {
      const v = await approvedVendor();
      const prod = await product(0, '10');
      const order = await sentOrder(v, [stockLine(prod)]);
      const line = required(order.lines[0]);
      const over = await c.rgns.saveDraft(staff('storeman'), null, order.id, header(dn()), [rl(line, '11')]);
      expect(await codeOf(c.rgns.post(staff('storeman'), over.id))).toBe('OVER_RECEIPT');
      await c.purchaseOrders.saveSettings(staff('admin'), { rfqRequiredAbove: '', amendmentTolerancePercent: '0', receiptTolerancePercent: '10' });
      expect(await codeOf(c.rgns.post(staff('storeman'), over.id))).toBe('OK');
      expect((await stockOf(prod)).stockQuantity).toBe(11);
      await c.purchaseOrders.saveSettings(staff('admin'), { rfqRequiredAbove: '', amendmentTolerancePercent: '0', receiptTolerancePercent: '0' });
    });

    it('a delivery note number is received once, an order is received only once sent, and a blocked vendor is refused', async () => {
      const v = await approvedVendor();
      const prod = await product(0, '10');
      const order = await sentOrder(v, [stockLine(prod, { quantity: '20' })]);
      const line = required(order.lines[0]);
      const note = dn();
      await receive(order.id, [rl(line, '5')], note);
      const again = await c.rgns.saveDraft(staff('storeman'), null, order.id, header(note.toLowerCase()), [rl(line, '5')]);
      expect(await codeOf(c.rgns.post(staff('storeman'), again.id))).toBe('DUPLICATE_NOTE');
      expect((await stockOf(prod)).stockQuantity).toBe(5);
      await db.update(schema.vendors).set({ block: 'all' }).where(eq(schema.vendors.id, v.vendorId));
      const other = await c.rgns.saveDraft(staff('storeman'), null, order.id, header(dn()), [rl(line, '5')]);
      expect(await codeOf(c.rgns.post(staff('storeman'), other.id))).toBe('VENDOR_BLOCKED');
      await db.update(schema.vendors).set({ block: 'none' }).where(eq(schema.vendors.id, v.vendorId));
      // Not yet sent: an approved order takes no goods.
      const v2 = await approvedVendor();
      catSeq += 1;
      const cat = await c.categories.save(companyId, null, { ...emptyCategory(), code: `RGX${String(catSeq)}_${run}`.toUpperCase(), name: `RGN x ${String(catSeq)} ${run}` });
      await c.categories.setStatus(companyId, cat.id, 'open');
      const { ids } = await c.prequal.apply(v2, companyId, [cat.id], TODAY);
      await c.prequal.submit(v2, required(ids[0]));
      await c.prequalReview.take(staff('evaluator'), required(ids[0]));
      await c.prequalReview.approve(staff('decider'), required(ids[0]), { maxOrderValue: '', note: '' }, TODAY);
      const draft = await c.purchaseOrders.saveDraft(staff('buyer'), null, { ...emptyPoHeader(TODAY), vendorId: v2.vendorId, categoryId: cat.id, currency: 'KES', noRfqReason: 'x' }, [stockLine(prod)], false);
      expect(await codeOf(c.rgns.saveDraft(staff('storeman'), null, draft.id, header(dn()), [rl('00000000-0000-4000-8000-000000000000', '1')]))).toBe('NOT_RECEIVABLE');
    });

    it('refuses a unit that is not the one the product is counted in, and stock from a foreign-currency order; a line with no product needs neither', async () => {
      const v = await approvedVendor();
      const prod = await product(0, '10');
      const wrongUnit = await sentOrder(v, [stockLine(prod, { unit: 'pallet' })]);
      const bad = await c.rgns.saveDraft(staff('storeman'), null, wrongUnit.id, header(dn()), [rl(required(wrongUnit.lines[0]), '1')]);
      expect(await codeOf(c.rgns.post(staff('storeman'), bad.id))).toBe('UNIT_MISMATCH');
      await db.insert(schema.currencies).values({ code: 'USD', name: 'US dollar', symbol: '$', isBaseCurrency: false }).onConflictDoNothing();
      const dollars = await sentOrder(v, [stockLine(prod)], { currency: 'USD' });
      const foreign = await c.rgns.saveDraft(staff('storeman'), null, dollars.id, header(dn()), [rl(required(dollars.lines[0]), '1')]);
      // Stock from a foreign-currency order needs the day's rate, and then costs what it is worth in the books' currency.
      expect(await codeOf(c.rgns.post(staff('storeman'), foreign.id))).toBe('NO_RATE');
      await c.finance.fx.setRate(staff('reviewer'), { currency: 'USD', effectiveOn: TODAY, rate: '130', note: 'test' });
      await c.rgns.post(staff('storeman'), foreign.id);
      const [costed] = await db.select().from(schema.rgnLines).where(eq(schema.rgnLines.rgnId, foreign.id));
      expect(Number(required(costed).unitCost)).toBe(90 * 130);
      const service = await sentOrder(v, [{ ...emptyPoLine(), description: 'Installation labour', quantity: '3', unit: 'day', unitPrice: '5000' }], { currency: 'USD' });
      await receive(service.id, [rl(required(service.lines[0]), '3')]);
      expect(required(await c.purchaseOrders.get(companyId, service.id)).po.status).toBe('received');
    });
  });

  describe('a posted note', () => {
    it('is fixed by the database, and a draft can be edited or cancelled', async () => {
      const v = await approvedVendor();
      const prod = await product(0, '10');
      const order = await sentOrder(v, [stockLine(prod)]);
      const line = required(order.lines[0]);
      const draft = await c.rgns.saveDraft(staff('storeman'), null, order.id, header(dn()), [rl(line, '2')]);
      await c.rgns.saveDraft(staff('storeman'), draft.id, order.id, header(dn()), [rl(line, '3')]);
      await c.rgns.cancelDraft(staff('storeman'), draft.id);
      expect(await codeOf(c.rgns.post(staff('storeman'), draft.id))).toBe('NOT_DRAFT');
      const posted = await receive(order.id, [rl(line, '2')]);
      expect(await codeOf(c.rgns.saveDraft(staff('storeman'), posted.id, order.id, header(dn()), [rl(line, '1')]))).toBe('NOT_DRAFT');
      expect(await codeOf(db.update(schema.rgnLines).set({ accepted: '9', delivered: '9' }).where(eq(schema.rgnLines.rgnId, posted.id)))).toBe('23001');
      expect(await codeOf(db.update(schema.rgns).set({ deliveryNoteNo: 'CHANGED' }).where(eq(schema.rgns.id, posted.id)))).toBe('23001');
      expect(await codeOf(db.delete(schema.rgns).where(eq(schema.rgns.id, posted.id)))).toBe('23001');
      expect(await codeOf(db.update(schema.purchaseOrderLines).set({ quantity: '99' }).where(eq(schema.purchaseOrderLines.id, line)))).toBe('23001');
    });
  });

  describe('reversing', () => {
    it('takes the stock out and reopens the order, with a reason, unless it was invoiced or the stock is gone', async () => {
      const v = await approvedVendor();
      const prod = await product(0, '10');
      const order = await sentOrder(v, [stockLine(prod)], { confirm: true });
      const line = required(order.lines[0]);
      const note = await receive(order.id, [rl(line, '10')]);
      expect(await codeOf(c.rgns.reverse(staff('storeman'), note.id, ' '))).toBe('NOTE_REQUIRED');
      // Some of it has been sold: the stock cannot be taken out.
      await db.update(schema.products).set({ stockQuantity: 6 }).where(eq(schema.products.id, prod));
      expect(await codeOf(c.rgns.reverse(staff('storeman'), note.id, 'Wrong order'))).toBe('STOCK_GONE');
      await db.update(schema.products).set({ stockQuantity: 10 }).where(eq(schema.products.id, prod));
      await db.update(schema.rgnLines).set({ invoicedQuantity: '4' }).where(eq(schema.rgnLines.rgnId, note.id));
      expect(await codeOf(c.rgns.reverse(staff('storeman'), note.id, 'Wrong order'))).toBe('ALREADY_INVOICED');
      await db.update(schema.rgnLines).set({ invoicedQuantity: '0' }).where(eq(schema.rgnLines.rgnId, note.id));
      await c.rgns.reverse(staff('storeman'), note.id, 'Wrong order');
      expect((await stockOf(prod)).stockQuantity).toBe(0);
      const po = required(await c.purchaseOrders.get(companyId, order.id));
      expect(po.po.status).toBe('confirmed');
      expect(po.lines[0]?.receivedQuantity).toBe('0.000');
      const moves = await db.select().from(schema.inventoryMovements).where(and(eq(schema.inventoryMovements.productId, prod), eq(schema.inventoryMovements.changeType, 'purchase_receipt_reversal')));
      expect(moves).toHaveLength(1);
      expect(await codeOf(c.rgns.reverse(staff('storeman'), note.id, 'again'))).toBe('NOT_POSTED');
      // The delivery note number is free to be received again after a reversal.
      const second = await c.rgns.saveDraft(staff('storeman'), null, order.id, header(required((await c.rgns.get(companyId, note.id))?.rgn.deliveryNoteNo)), [rl(line, '10')]);
      expect(await codeOf(c.rgns.post(staff('storeman'), second.id))).toBe('OK');
    });
  });

  describe('reports and the vendor’s view', () => {
    it('lists what was received and not invoiced, with its value and age, and drops it when invoiced', async () => {
      const v = await approvedVendor();
      const prod = await product(0, '10');
      const order = await sentOrder(v, [stockLine(prod)]);
      const note = await receive(order.id, [rl(required(order.lines[0]), '5')]);
      const report = await c.rgns.notInvoiced(companyId, TODAY);
      const row = report.rows.find((r) => r.rgn === note.number);
      expect(row).toMatchObject({ openQuantity: '5.000', value: '450.00', ageDays: 0, po: order.number });
      expect(report.totalValue).toBeGreaterThanOrEqual(450);
      const later = await c.rgns.notInvoiced(companyId, businessDate(new Date(Date.now() + 40 * 86_400_000)));
      expect(later.rows.find((r) => r.rgn === note.number)?.ageDays).toBe(40);
      await db.update(schema.rgnLines).set({ invoicedQuantity: '5' }).where(eq(schema.rgnLines.rgnId, note.id));
      expect((await c.rgns.notInvoiced(companyId, TODAY)).rows.some((r) => r.rgn === note.number)).toBe(false);
    });

    it('shows the vendor what was accepted and refused, and why, on its own orders only', async () => {
      const v = await approvedVendor();
      const other = await approvedVendor();
      const prod = await product(0, '10');
      const order = await sentOrder(v, [stockLine(prod)]);
      await receive(order.id, [rl(required(order.lines[0]), '10', '2', 'damaged')]);
      const view = await c.poPortal.load(v, order.id);
      expect(view.deliveries).toHaveLength(1);
      expect(view.deliveries[0]?.lines[0]).toMatchObject({ delivered: '10.000', accepted: '8.000', rejected: '2.000', rejectReason: 'damaged' });
      expect(await codeOf(c.poPortal.load(other, order.id))).toBe('NOT_FOUND');
    });
  });
});
