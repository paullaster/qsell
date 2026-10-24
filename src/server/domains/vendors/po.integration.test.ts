import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { has, isRecord, readText, required } from '@/lib/values';
import { emptyBusiness, emptyFinancial, emptyProfile, type ProfileData } from '@/lib/vendor-profile';
import { emptyCategory } from '@/lib/prequalification';
import { blankQuoteLine, emptyRfqHeader, emptyRfqLine } from '@/lib/rfq';
import { emptyPoHeader, emptyPoLine, type PoHeaderForm, type PoLineForm } from '@/lib/purchase-order';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import type * as mod_schema from '@/server/db/drizzle/schema';
import type { AppContainer } from '@/server/di/container';
import type { FinanceContext } from '@/server/domains/finance/errors';
import type { EmailMessage, EmailPort } from '@/server/ports/communications';
import type { PortalActor } from './profile-service';
import type { PurchaseOrderService } from './po-service';
import type { PurchaseOrderPortalService } from './po-portal-service';
import type { AdvancePaymentService } from './advance-service';

/** Needs a Postgres built from the migrations:  TEST_DATABASE_URL=postgres://... pnpm test */
const url = process.env.TEST_DATABASE_URL;

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const TODAY = new Date().toISOString().slice(0, 10);
const NO = { maySkipRfq: false, mayOverrideQualification: false };

class Outbox implements EmailPort {
  readonly name = 'recorder';
  sent: EmailMessage[] = [];
  send(message: EmailMessage) {
    this.sent.push(message);
    return Promise.resolve({ messageId: 'x', provider: 'recorder' });
  }
}

describe.skipIf(!has(url))('purchase orders and advance payments (database)', () => {
  let db: DrizzleDb;
  let schema: typeof mod_schema;
  let c: AppContainer;
  let companyId: string;
  let orders: PurchaseOrderService;
  let portal: PurchaseOrderPortalService;
  let advances: AdvancePaymentService;
  const outbox = new Outbox();
  const run = randomUUID().slice(0, 6);
  let seq = 0;
  let catSeq = 0;

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
    const [u] = await db.insert(schema.users).values({ email: `po${String(seq)}.${run}@example.test`, passwordHash: 'x', name: 'Owner', role: 'vendor' }).returning();
    const vendorId = await c.vendors.registerBusiness({ companyId, userId: required(u).id, legalName: `PO Vendor ${run} ${String(seq)}`, email: `po${String(seq)}.${run}@example.test`, phone: null });
    const a: PortalActor = { vendorId, userId: required(u).id, portalRole: 'owner' };
    const p = c.vendorProfile;
    const profile: ProfileData = { ...emptyProfile(), country: 'Kenya', description: 'We supply solar panels and inverters to businesses.', physicalStreet: '1 Mombasa Road', physicalCity: 'Nairobi', phone: '+254 700 000 000' };
    await p.saveProfile(a, profile);
    await p.saveBusiness(a, { ...emptyBusiness(), registrationNo: 'CPR/2012/12345', registrationDate: '2012-03-04', taxId: `O${String(Date.now()).slice(-9)}${String(seq % 10)}` });
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

  async function qualifiedIn(a: PortalActor, categoryId?: string): Promise<string> {
    let cat = categoryId;
    if (cat === undefined) {
      catSeq += 1;
      const made = await c.categories.save(companyId, null, { ...emptyCategory(), code: `PO${String(catSeq)}_${run}`.toUpperCase(), name: `PO category ${String(catSeq)} ${run}` });
      await c.categories.setStatus(companyId, made.id, 'open');
      cat = made.id;
    }
    const { ids } = await c.prequal.apply(a, companyId, [cat], TODAY);
    const id = required(ids[0]);
    await c.prequal.submit(a, id);
    await c.prequalReview.take(staff('evaluator'), id);
    await c.prequalReview.approve(staff('decider'), id, { maxOrderValue: '', note: '' }, TODAY);
    return cat;
  }

  const header = (v: PortalActor, categoryId: string, over: Partial<PoHeaderForm> = {}): PoHeaderForm => ({ ...emptyPoHeader(TODAY), vendorId: v.vendorId, categoryId, currency: 'KES', noRfqReason: 'Emergency repair', paymentTerms: '30 days', ...over });
  const lines = (over: Partial<PoLineForm> = {}): PoLineForm[] => [{ ...emptyPoLine(), description: 'Inverter 5kW', quantity: '4', unitPrice: '1000', taxRate: '16', ...over }, { ...emptyPoLine(), description: 'Cable 6mm', quantity: '100', unit: 'm', unitPrice: '2.50' }];

  /** An order that is written, sent for approval by `buyer`, and approved by `boss`. */
  async function approved(v: PortalActor, categoryId: string, over: Partial<PoHeaderForm> = {}): Promise<string> {
    const { id } = await orders.saveDraft(staff('buyer'), null, header(v, categoryId, over), lines(), true);
    await orders.submit(staff('buyer'), id, NO);
    await orders.approve(staff('boss'), id);
    return id;
  }

  async function released(v: PortalActor, categoryId: string, over: Partial<PoHeaderForm> = {}): Promise<string> {
    const id = await approved(v, categoryId, over);
    await orders.send(staff('buyer'), id);
    return id;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    ({ drizzleDb: db } = await import('@/server/db/drizzle/client'));
    schema = await import('@/server/db/drizzle/schema');
    const { getContainer } = await import('@/server/di/container');
    const { VendorNotifier } = await import('./notifier');
    const { PurchaseOrderService: Svc } = await import('./po-service');
    const { PurchaseOrderPortalService: Portal } = await import('./po-portal-service');
    const { AdvancePaymentService: Adv } = await import('./advance-service');
    c = getContainer();
    const [company] = await db
      .insert(schema.companySettings)
      .values({ legalName: 'PO', tradingName: 'PO', email: 'buyer@po.test', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P', publicBaseUrl: 'https://shop.test' })
      .returning();
    companyId = required(company).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    await c.finance.setup.applyTemplate(staff('reviewer'), 'kenya', { fiscalYearStart: '2026-01-01' });
    const notifier = new VendorNotifier(db, outbox, c.companySettings);
    orders = new Svc(db, c.numbering, c.prequalLifecycle, notifier);
    portal = new Portal(db, orders);
    advances = new Adv(db, notifier);
  });

  describe('writing and approving', () => {
    it('works out the totals itself, needs a reason without a request for quotation, and only a flagging person sets the advance flag', async () => {
      const v = await approvedVendor();
      const cat = await qualifiedIn(v);
      expect(await codeOf(orders.saveDraft(staff('buyer'), null, header(v, cat, { noRfqReason: '' }), lines(), true))).toBe('INVALID');
      expect(await codeOf(orders.saveDraft(staff('buyer'), null, header(v, cat, { requiresAdvancePayment: true }), lines(), false))).toBe('NOT_ALLOWED');
      const { id } = await orders.saveDraft(staff('buyer'), null, header(v, cat, { requiresAdvancePayment: true }), lines(), true);
      const got = required(await orders.get(companyId, id));
      // 4 x 1000 + 16% = 4640.00; 100 x 2.50 = 250.00
      expect(got.po).toMatchObject({ subtotal: '4250.00', taxTotal: '640.00', total: '4890.00', status: 'draft', number: null, noRfq: true });
      expect(got.lines.map((l) => l.lineTotal)).toEqual(['4640.00', '250.00']);
      expect(await codeOf(orders.saveDraft(staff('buyer'), id, header(v, cat, { requiresAdvancePayment: false }), lines(), false))).toBe('NOT_ALLOWED');
      expect(await codeOf(orders.saveDraft(staff('buyer'), id, header(v, cat), [{ ...emptyPoLine(), description: 'x' }], true))).toBe('INVALID');
    });

    it('is approved by someone other than the writer, gets its number then, and is then fixed', async () => {
      const v = await approvedVendor();
      const cat = await qualifiedIn(v);
      const { id } = await orders.saveDraft(staff('buyer'), null, header(v, cat), lines(), true);
      expect(await codeOf(orders.submit(staff('someone-else'), id, NO))).toBe('NOT_YOURS');
      await orders.submit(staff('buyer'), id, NO);
      expect(await codeOf(orders.approve(staff('buyer'), id))).toBe('FOUR_EYES');
      expect(await codeOf(orders.saveDraft(staff('buyer'), id, header(v, cat), lines(), true))).toBe('NOT_DRAFT');
      const { number } = await orders.approve(staff('boss'), id);
      expect(number).toMatch(/^PO-\d{4}-\d{5}$/);
      const got = required(await orders.get(companyId, id));
      expect(got.po.status).toBe('approved');
      expect(got.versions.map((x) => x.version)).toEqual([1]);
      // The database keeps a released order as it was, whoever asks.
      expect(await codeOf(db.update(schema.purchaseOrders).set({ total: '1.00' }).where(eq(schema.purchaseOrders.id, id)))).toBe('23001');
      expect(await codeOf(db.update(schema.purchaseOrders).set({ number: 'PO-X' }).where(eq(schema.purchaseOrders.id, id)))).toBe('23001');
      expect(await codeOf(db.insert(schema.purchaseOrderLines).values({ poId: id, position: 9, description: 'Sneaky', quantity: '1', unitPrice: '1' }))).toBe('23001');
      expect(await codeOf(db.delete(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, id)))).toBe('23001');
      expect(await codeOf(db.update(schema.purchaseOrders).set({ approvedBy: 'buyer' }).where(eq(schema.purchaseOrders.id, id)))).toBe('23514');
      expect(await codeOf(db.delete(schema.purchaseOrderVersions).where(eq(schema.purchaseOrderVersions.poId, id)))).toBe('23001');
    });

    it('can be sent back or reopened, and a reopened order keeps the number it was given', async () => {
      const v = await approvedVendor();
      const cat = await qualifiedIn(v);
      const { id } = await orders.saveDraft(staff('buyer'), null, header(v, cat), lines(), true);
      await orders.submit(staff('buyer'), id, NO);
      expect(await codeOf(orders.reject(staff('boss'), id, ' '))).toBe('NOTE_REQUIRED');
      await orders.reject(staff('boss'), id, 'The price looks high');
      expect(required(await orders.get(companyId, id)).po.status).toBe('draft');
      await orders.submit(staff('buyer'), id, NO);
      const first = await orders.approve(staff('boss'), id);
      await orders.reopen(staff('buyer'), id, 'Wrong delivery date');
      await orders.submit(staff('buyer'), id, NO);
      const again = await orders.approve(staff('boss2'), id);
      expect(again.number).toBe(first.number);
      await orders.send(staff('buyer'), id);
      expect(await codeOf(orders.reopen(staff('buyer'), id, 'late'))).toBe('NOT_ALLOWED');
    });

    it('needs a qualified vendor unless someone allowed overrides it with a reason, and a request for quotation above the policy value unless skipped', async () => {
      const v = await approvedVendor();
      const other = await approvedVendor();
      const cat = await qualifiedIn(v);
      const { id } = await orders.saveDraft(staff('buyer'), null, header(other, cat), lines(), true);
      expect(await codeOf(orders.submit(staff('buyer'), id, NO))).toBe('NOT_QUALIFIED');
      expect(await codeOf(orders.submit(staff('buyer'), id, { ...NO, mayOverrideQualification: true }))).toBe('OVERRIDE_REASON');
      await orders.submit(staff('buyer'), id, { ...NO, mayOverrideQualification: true, overrideReason: 'Emergency: generator failed' });
      expect(required(await orders.get(companyId, id)).po.qualificationOverrideReason).toBe('Emergency: generator failed');

      await orders.saveSettings(staff('admin'), { rfqRequiredAbove: '1000', amendmentTolerancePercent: '0' });
      const big = await orders.saveDraft(staff('buyer'), null, header(v, cat), lines(), true);
      expect(await codeOf(orders.submit(staff('buyer'), big.id, NO))).toBe('RFQ_REQUIRED');
      expect(await codeOf(orders.submit(staff('buyer'), big.id, { ...NO, maySkipRfq: true }))).toBe('OK');
      await orders.saveSettings(staff('admin'), { rfqRequiredAbove: '', amendmentTolerancePercent: '0' });
      expect((await orders.settings(companyId)).rfqRequiredAbove).toBeNull();
      expect(await codeOf(orders.saveSettings(staff('admin'), { rfqRequiredAbove: 'lots', amendmentTolerancePercent: '0' }))).toBe('INVALID');
    });

    it('will not be ordered from a vendor that is blocked from everything or not active', async () => {
      const v = await approvedVendor();
      const cat = await qualifiedIn(v);
      const { id } = await orders.saveDraft(staff('buyer'), null, header(v, cat), lines(), true);
      await db.update(schema.vendors).set({ block: 'all' }).where(eq(schema.vendors.id, v.vendorId));
      expect(await codeOf(orders.submit(staff('buyer'), id, NO))).toBe('VENDOR_NOT_ACTIVE');
    });
  });

  describe('sending and confirming', () => {
    it('reaches the vendor only once sent, is confirmed by the owner or sales, and nobody else sees it', async () => {
      const v = await approvedVendor();
      const other = await approvedVendor();
      const cat = await qualifiedIn(v);
      const id = await approved(v, cat);
      expect((await portal.list(v.vendorId)).rows).toEqual([]);
      expect(await codeOf(portal.load(v, id))).toBe('NOT_FOUND');
      outbox.sent = [];
      await orders.send(staff('buyer'), id);
      expect(outbox.sent.some((m) => m.subject.startsWith('Purchase order PO-'))).toBe(true);
      expect(await codeOf(orders.send(staff('buyer'), id))).toBe('NOT_APPROVED');
      const row = required((await portal.list(v.vendorId)).rows[0]);
      expect(row).toMatchObject({ status: 'sent', needsConfirmation: true, total: '4890.00' });
      expect(await codeOf(portal.load(other, id))).toBe('NOT_FOUND');
      expect(await codeOf(portal.confirm({ ...v, portalRole: 'finance' }, id, companyId))).toBe('NOT_ALLOWED');
      expect(await codeOf(portal.confirm(other, id, companyId))).toBe('NOT_FOUND');
      outbox.sent = [];
      await portal.confirm(v, id, companyId);
      expect((await portal.load(v, id)).status).toBe('confirmed');
      expect(outbox.sent.some((m) => m.to === 'buyer@po.test')).toBe(true);
      expect(await codeOf(portal.confirm(v, id, companyId))).toBe('NOT_SENT');
    });

    it('can be confirmed by staff on the vendor’s behalf, with how it was confirmed', async () => {
      const v = await approvedVendor();
      const cat = await qualifiedIn(v);
      const id = await released(v, cat);
      expect(await codeOf(orders.recordConfirmation(staff('buyer'), id, ' ', new Date()))).toBe('NOTE_REQUIRED');
      await orders.recordConfirmation(staff('buyer'), id, 'Phone call with the finance manager', new Date());
      const got = required(await orders.get(companyId, id));
      expect(got.po).toMatchObject({ status: 'confirmed', confirmationNote: 'Phone call with the finance manager' });
    });
  });

  describe('amendments', () => {
    const amendInput = (over: Partial<PoLineForm>, reason = 'Price agreed down') => async (id: string) => {
      const got = required(await orders.get(companyId, id));
      return { header: { expectedDate: got.po.expectedDate ?? '', paymentTerms: got.po.paymentTerms ?? '', deliveryTerms: got.po.deliveryTerms ?? '', notesToVendor: '', requiresAdvancePayment: got.po.requiresAdvancePayment }, lines: got.lines.map((l, i) => ({ id: l.id, productId: '', description: l.description, specification: '', quantity: l.quantity, unit: l.unit, unitPrice: l.unitPrice, discountPercent: l.discountPercent, taxRate: l.taxRate, expectedDate: '', ...(i === 0 ? over : {}) })), reason };
    };

    it('a price change needs someone else’s approval, then becomes the next version, tells the vendor what changed and asks it to confirm again', async () => {
      const v = await approvedVendor();
      const cat = await qualifiedIn(v);
      const id = await released(v, cat);
      await portal.confirm(v, id, companyId);
      const input = await amendInput({ unitPrice: '950' })(id);
      expect(await codeOf(orders.amend(staff('buyer'), id, { ...input, reason: ' ' }, false))).toBe('NOTE_REQUIRED');
      const r = await orders.amend(staff('buyer'), id, input, false);
      expect(r).toEqual({ applied: false, version: null });
      expect(required(await orders.get(companyId, id)).po.status).toBe('amendment_pending');
      expect(await codeOf(orders.amend(staff('buyer'), id, input, false))).toBe('NOT_ALLOWED');
      const amendment = required(required(await orders.get(companyId, id)).amendments[0]);
      expect(await codeOf(orders.decideAmendment(staff('buyer'), amendment.id, true, ''))).toBe('FOUR_EYES');
      outbox.sent = [];
      await orders.decideAmendment(staff('boss'), amendment.id, true, '');
      const got = required(await orders.get(companyId, id));
      expect(got.po).toMatchObject({ version: 2, status: 'sent', confirmedAt: null, total: '4658.00' });
      expect(got.versions.map((x) => x.version)).toEqual([2, 1]);
      expect(outbox.sent.some((m) => m.subject.includes('was changed') && (m.text ?? '').includes('Inverter 5kW: price 1000.00 to 950'))).toBe(true);
      const view = await portal.load(v, id);
      expect(view.canConfirm).toBe(true);
      expect(view.versions[0]?.changes.join(' ')).toMatch(/total changed from 4890.00 to 4658.00/);
      await portal.confirm(v, id, companyId);
      expect((await portal.load(v, id)).status).toBe('confirmed');
    });

    it('a smaller or later order applies at once; a refused change returns the order to where it was; nothing changed is refused', async () => {
      const v = await approvedVendor();
      const cat = await qualifiedIn(v);
      const id = await released(v, cat);
      expect(await codeOf(orders.amend(staff('buyer'), id, await amendInput({})(id), false))).toBe('NO_CHANGE');
      const small = await orders.amend(staff('buyer'), id, await amendInput({ quantity: '3' }, 'We need fewer')(id), false);
      expect(small).toEqual({ applied: true, version: 2 });
      expect(required(await orders.get(companyId, id)).po).toMatchObject({ version: 2, status: 'sent', total: '3730.00' });
      await orders.amend(staff('buyer'), id, await amendInput({ unitPrice: '900' })(id), false);
      const pending = required(required(await orders.get(companyId, id)).amendments.find((a) => a.status === 'pending_approval'));
      expect(await codeOf(orders.decideAmendment(staff('boss'), pending.id, false, ''))).toBe('NOTE_REQUIRED');
      await orders.decideAmendment(staff('boss'), pending.id, false, 'Price not agreed');
      expect(required(await orders.get(companyId, id)).po).toMatchObject({ version: 2, status: 'sent' });
      expect(await codeOf(orders.decideAmendment(staff('boss'), pending.id, true, ''))).toBe('NOT_PENDING');
    });

    it('cannot take the quantity below what was received', async () => {
      const v = await approvedVendor();
      const cat = await qualifiedIn(v);
      const id = await released(v, cat);
      const line = required(required(await orders.get(companyId, id)).lines[0]);
      await db.update(schema.purchaseOrderLines).set({ receivedQuantity: '3' }).where(eq(schema.purchaseOrderLines.id, line.id));
      expect(await codeOf(orders.amend(staff('buyer'), id, await amendInput({ quantity: '2' })(id), false))).toBe('ALREADY_RECEIVED');
      expect(await codeOf(orders.cancel(staff('buyer'), id, 'No longer needed'))).toBe('ALREADY_RECEIVED');
      await orders.close(staff('buyer'), id, 'Short delivery accepted');
      expect(required(await orders.get(companyId, id)).po.status).toBe('closed');
    });
  });

  describe('cancelling', () => {
    it('tells a vendor that was sent the order, withdraws a waiting change and an unpaid advance, and refuses once an advance was paid', async () => {
      const v = await approvedVendor();
      const cat = await qualifiedIn(v);
      const id = await released(v, cat, { requiresAdvancePayment: true });
      const { id: advanceId } = await advances.create(staff('buyer'), id, { amount: '1000', dueDate: '', reason: 'Deposit to start' });
      outbox.sent = [];
      expect(await codeOf(orders.cancel(staff('buyer'), id, ' '))).toBe('NOTE_REQUIRED');
      await orders.cancel(staff('buyer'), id, 'Budget withdrawn');
      expect(outbox.sent.some((m) => m.subject.includes('is cancelled') && (m.text ?? '').includes('Budget withdrawn'))).toBe(true);
      const [adv] = await db.select().from(schema.vendorAdvancePayments).where(eq(schema.vendorAdvancePayments.id, advanceId));
      expect(adv?.status).toBe('cancelled');
      expect((await portal.load(v, id)).cancelReason).toBe('Budget withdrawn');

      const paidOrder = await released(v, cat, { requiresAdvancePayment: true });
      const paid = await advances.create(staff('buyer'), paidOrder, { amount: '1000', dueDate: '', reason: 'Deposit to start' });
      await advances.submit(staff('buyer'), paid.id);
      await advances.approve(staff('boss'), paid.id);
      await advances.recordPayment(companyId, paid.id, randomUUID());
      expect(await codeOf(orders.cancel(staff('buyer'), paidOrder, 'Changed our mind'))).toBe('ADVANCE_PAID');
    });
  });

  describe('making an order from an award', () => {
    async function awarded(vendors: PortalActor[]) {
      catSeq += 1;
      const cat = await c.categories.save(companyId, null, { ...emptyCategory(), code: `AW${String(catSeq)}_${run}`.toUpperCase(), name: `Award category ${String(catSeq)} ${run}` });
      await c.categories.setStatus(companyId, cat.id, 'open');
      for (const v of vendors) await qualifiedIn(v, cat.id);
      const two = (n: number) => String(n).padStart(2, '0');
      const d = new Date(Date.now() + 72 * 3_600_000);
      const deadline = `${String(d.getFullYear())}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
      const { id } = await c.rfqs.saveDraft(staff('buyer'), null, { ...emptyRfqHeader(), title: `Award ${run}`, categoryId: cat.id, deadline, currency: 'KES', validityDays: '30' }, [{ ...emptyRfqLine(), description: 'Inverter 5kW', quantity: '4' }, { ...emptyRfqLine(), description: 'Cable 6mm', quantity: '100', unit: 'm' }]);
      await c.rfqs.setInvitees(staff('buyer'), id, vendors.map((x) => x.vendorId), TODAY);
      await c.rfqs.issue(staff('buyer'), id);
      const got = required(await c.rfqs.get(companyId, id));
      const [la, lb] = got.lines;
      for (const [i, v] of vendors.entries()) {
        await c.rfqPortal.saveDraft(v, id, { paymentTerms: '45 days', deliveryTerms: 'DAP Nairobi', validUntil: new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10), notes: '', lines: [{ ...blankQuoteLine(required(la).id, 4), unitPrice: String(1000 - i * 50), taxRate: '16', leadTimeDays: '14' }, { ...blankQuoteLine(required(lb).id, 100), unitPrice: '2.5' }] });
        await c.rfqPortal.submit(v, id, companyId);
      }
      await db.update(schema.rfqs).set({ deadline: new Date(Date.now() - 60_000), opensAt: new Date(Date.now() - 60_000) }).where(eq(schema.rfqs.id, id));
      await c.rfqs.closeDue(new Date());
      return { id, cat: cat.id, lineA: required(la).id, lineB: required(lb).id };
    }

    it('makes one draft per awarded vendor with the awarded quantity and price, nothing retyped, once', async () => {
      const a = await approvedVendor();
      const b = await approvedVendor();
      const r = await awarded([a, b]);
      expect(await codeOf(orders.createFromAward(staff('buyer'), r.id, a.vendorId))).toBe('NOT_AWARDED');
      await c.rfqEvaluation.award(staff('buyer'), r.id, [{ rfqLineId: r.lineA, vendorId: b.vendorId, quantity: '4' }, { rfqLineId: r.lineB, vendorId: a.vendorId, quantity: '100' }], '');
      const forB = await orders.createFromAward(staff('buyer'), r.id, b.vendorId, TODAY);
      expect(forB.created).toBe(true);
      expect((await orders.createFromAward(staff('buyer'), r.id, b.vendorId, TODAY))).toEqual({ id: forB.id, created: false });
      const got = required(await orders.get(companyId, forB.id));
      expect(got.po).toMatchObject({ status: 'draft', noRfq: false, currency: 'KES', paymentTerms: '45 days', deliveryTerms: 'DAP Nairobi', total: '4408.00' });
      expect(got.rfqNumber).toMatch(/^RFQ-/);
      expect(got.lines).toHaveLength(1);
      expect(got.lines[0]).toMatchObject({ description: 'Inverter 5kW', quantity: '4.000', unitPrice: '950.00', taxRate: '16.00' });
      expect(got.lines[0]?.expectedDate).toBe(new Date(new Date(`${TODAY}T00:00:00Z`).getTime() + 14 * 86_400_000).toISOString().slice(0, 10));
      const todo = await orders.toMake(companyId, r.id);
      expect(todo.map((x) => [x.lines, x.orderId !== null])).toEqual(expect.arrayContaining([[1, true], [1, false]]));
      await orders.submit(staff('buyer'), forB.id, NO);
      await orders.approve(staff('boss'), forB.id);
      const stranger = await approvedVendor();
      expect(await codeOf(orders.createFromAward(staff('buyer'), r.id, stranger.vendorId))).toBe('NOT_AWARDED');
      // A cancelled order frees the place for a new one.
      await orders.cancel(staff('buyer'), forB.id, 'Redo it');
      expect((await orders.createFromAward(staff('buyer'), r.id, b.vendorId, TODAY)).created).toBe(true);
    });
  });

  describe('the advance payment document', () => {
    it('needs the flag and a released order, stays within the total, is approved by someone else, and fixes the bank account', async () => {
      const v = await approvedVendor();
      const cat = await qualifiedIn(v);
      const plain = await released(v, cat);
      expect(await codeOf(advances.create(staff('buyer'), plain, { amount: '100', dueDate: '', reason: 'Deposit' }))).toBe('NOT_FLAGGED');
      const flagged = await approved(v, cat, { requiresAdvancePayment: true });
      const ok = { amount: '1000', dueDate: '2026-12-01', reason: 'Deposit to start work' };
      await orders.send(staff('buyer'), flagged);
      expect(await codeOf(advances.create(staff('buyer'), flagged, { ...ok, amount: '5000' }))).toBe('INVALID');
      expect(await codeOf(advances.create(staff('buyer'), flagged, { ...ok, reason: '' }))).toBe('INVALID');
      const { id } = await advances.create(staff('buyer'), flagged, ok);
      expect(await codeOf(advances.create(staff('buyer'), flagged, ok))).toBe('ALREADY');
      expect(await codeOf(advances.approve(staff('boss'), id))).toBe('NOT_PENDING');
      expect(await codeOf(advances.submit(staff('other'), id))).toBe('NOT_YOURS');
      await advances.submit(staff('buyer'), id);
      expect(await codeOf(advances.approve(staff('buyer'), id))).toBe('FOUR_EYES');
      expect(await codeOf(db.update(schema.vendorAdvancePayments).set({ approvedBy: 'buyer' }).where(eq(schema.vendorAdvancePayments.id, id)))).toBe('23514');
      outbox.sent = [];
      await advances.approve(staff('boss'), id);
      const [row] = await db.select().from(schema.vendorAdvancePayments).where(eq(schema.vendorAdvancePayments.id, id));
      const [bank] = await db.select().from(schema.vendorBankAccounts).where(eq(schema.vendorBankAccounts.id, required(row?.bankAccountId ?? undefined)));
      expect(bank?.status).toBe('active');
      expect(row?.status).toBe('approved');
      expect(outbox.sent.some((m) => m.subject.startsWith('Advance payment approved'))).toBe(true);
      const view = await portal.load(v, flagged);
      expect(view.advance).toMatchObject({ amount: '1000.00', status: 'approved' });
    });

    it('can be paid once only, and its being approved or paid is what lets an invoice with no delivery note through', async () => {
      const v = await approvedVendor();
      const cat = await qualifiedIn(v);
      const flagged = await released(v, cat, { requiresAdvancePayment: true });
      const plain = await released(v, cat);
      expect((await advances.hasCover(plain)).ok).toBe(false);
      expect((await advances.hasCover(plain)).reason).toMatch(/not set up to require an advance/);
      expect((await advances.hasCover(flagged)).reason).toMatch(/No approved advance payment/);
      const { id } = await advances.create(staff('buyer'), flagged, { amount: '500', dueDate: '', reason: 'Deposit to start work' });
      expect((await advances.hasCover(flagged)).ok).toBe(false);
      await advances.submit(staff('buyer'), id);
      expect(await codeOf(advances.recordPayment(companyId, id, randomUUID()))).toBe('NOT_APPROVED');
      await advances.reject(staff('boss'), id, 'Amount too high');
      await advances.submit(staff('buyer'), id);
      await advances.approve(staff('boss'), id);
      expect((await advances.hasCover(flagged)).ok).toBe(true);
      await advances.recordPayment(companyId, id, randomUUID());
      expect((await advances.hasCover(flagged)).ok).toBe(true);
      expect(await codeOf(advances.recordPayment(companyId, id, randomUUID()))).toBe('NOT_APPROVED');
      expect(await codeOf(advances.cancel(staff('buyer'), id, 'Changed our mind'))).toBe('ALREADY_PAID');
      expect((await advances.list(companyId, 'paid')).some((x) => x.a.id === id)).toBe(true);
    });
  });
});
