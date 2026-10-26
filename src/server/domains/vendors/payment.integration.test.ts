import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import { has, isRecord, readText, required } from '@/lib/values';
import { emptyBusiness, emptyFinancial, emptyProfile, type ProfileData } from '@/lib/vendor-profile';
import { emptyCategory } from '@/lib/prequalification';
import { emptyPoHeader, emptyPoLine, type PoLineForm } from '@/lib/purchase-order';
import type { RgnHeaderForm, RgnLineForm } from '@/lib/rgn';
import { emptyInvoiceHeader, type DeliveryNoteForm, type InvoiceLineForm } from '@/lib/supplier-invoice';
import type { AllocationForm, VoucherHeaderForm } from '@/lib/vendor-payment';
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

describe.skipIf(!has(url))('vendor payments (database)', () => {
  let db: DrizzleDb;
  let schema: typeof mod_schema;
  let c: AppContainer;
  let companyId: string;
  let unit: { code: string; name: string };
  let inputTax = '';
  let cash = '';
  let transfer = '';
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
    const [u] = await db.insert(schema.users).values({ email: `vp${String(seq)}.${run}@example.test`, passwordHash: 'x', name: 'Owner', role: 'vendor' }).returning();
    const vendorId = await c.vendors.registerBusiness({ companyId, userId: required(u).id, legalName: `VP Vendor ${run} ${String(seq)}`, email: `vp${String(seq)}.${run}@example.test`, phone: null });
    const a: PortalActor = { vendorId, userId: required(u).id, portalRole: 'owner' };
    const p = c.vendorProfile;
    const profile: ProfileData = { ...emptyProfile(), country: 'Kenya', description: 'We supply solar panels and inverters to businesses.', physicalStreet: '1 Mombasa Road', physicalCity: 'Nairobi', phone: '+254 700 000 000' };
    await p.saveProfile(a, profile);
    await p.saveBusiness(a, { ...emptyBusiness(), registrationNo: 'CPR/2012/12345', registrationDate: '2012-03-04', taxId: `G${String(Date.now()).slice(-9)}${String(seq % 10)}` });
    await p.addDirector(a, { name: 'Wanjiru Kamau', idType: 'national_id', idNumber: '12345678', sharePercent: '100' });
    await p.addBank(a, { bankName: 'KCB', branch: 'Moi Avenue', accountName: 'Acme Ltd', accountNumber: `0123${String(seq).padStart(6, '0')}`, swift: '' });
    await p.saveFinancial(a, { ...emptyFinancial(), offeredPaymentTermDays: '30' });
    await p.saveContacts(a, [{ name: 'Wanjiru Kamau', role: 'management', email: `vw${String(seq)}.${run}@acme.test`, phone: '0700000000', isPrimary: true }]);
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
    await db.insert(schema.products).values({ id, sku: `VP-${run}-${String(prodSeq)}`.toUpperCase(), stockCode: `VPS-${run}-${String(prodSeq)}`.toUpperCase(), name: `Receiving ${String(prodSeq)}`, slug: `vp-${randomUUID()}`, itemTypeId, price: '999', costPrice: cost, stockQuantity: stock });
    return id;
  }

  /** A sent order with the lines given, for a qualified vendor; returns the order and its line ids. */
  async function sentOrder(v: PortalActor, lines: PoLineForm[], over: { currency?: string; confirm?: boolean; advance?: boolean } = {}) {
    catSeq += 1;
    const cat = await c.categories.save(companyId, null, { ...emptyCategory(), code: `VP${String(catSeq)}_${run}`.toUpperCase(), name: `VP category ${String(catSeq)} ${run}` });
    await c.categories.setStatus(companyId, cat.id, 'open');
    const { ids } = await c.prequal.apply(v, companyId, [cat.id], TODAY);
    await c.prequal.submit(v, required(ids[0]));
    await c.prequalReview.take(staff('evaluator'), required(ids[0]));
    await c.prequalReview.approve(staff('decider'), required(ids[0]), { maxOrderValue: '', note: '' }, TODAY);
    const { id } = await c.purchaseOrders.saveDraft(staff('buyer'), null, { ...emptyPoHeader(TODAY), vendorId: v.vendorId, categoryId: cat.id, currency: over.currency ?? 'KES', noRfqReason: 'Test', requiresAdvancePayment: over.advance === true }, lines, over.advance === true);
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

  const lineForms = (rows: [string, string, string][]): InvoiceLineForm[] => rows.map(([poLineId, quantity, unitPrice]) => ({ poLineId, quantity, unitPrice }));
  const noteForm = (noteNo: string, fileId: string): DeliveryNoteForm => ({ noteNo, noteDate: TODAY, fileId });

  async function file(v: PortalActor): Promise<string> {
    return (await c.invoicePortal.addFile(v, companyId, { originalName: 'scan.pdf', data: PDF })).id;
  }

  /** An order received in full for a stock product, with a draft invoice started from it. */
  async function setup(over: { qty?: string; receive?: string; discount?: string } = {}) {
    const v = await approvedVendor();
    const prod = await product(0, '10');
    const order = await sentOrder(v, [stockLine(prod, { quantity: over.qty ?? '10', discountPercent: over.discount ?? '0', unitPrice: '100' })], { confirm: true });
    const line = required(order.lines[0]);
    const note = dn();
    await receive(order.id, [rl(line, over.receive ?? over.qty ?? '10')], note);
    return { v, prod, order, line, note };
  }

  async function submitted(s: Awaited<ReturnType<typeof setup>>, no = `INV-${run}-${String(++seq)}`, price = '100', qty?: string) {
    const { id } = await c.invoicePortal.start(s.v, companyId, { poId: s.order.id, vendorInvoiceNo: no });
    const loaded = await c.invoicePortal.load(s.v, id);
    const scan = await file(s.v);
    const dnFile = await file(s.v);
    await c.invoicePortal.save(s.v, id, {
      header: { ...emptyInvoiceHeader(TODAY), vendorInvoiceNo: no, declaration: true },
      lines: lineForms([[s.line, qty ?? required(loaded.lines[0]).quantity, price]]),
      deliveryNotes: [noteForm(s.note, dnFile)],
      invoiceFileId: scan,
    });
    const { number } = await c.invoicePortal.submit(s.v, companyId, id);
    return { id, number, no };
  }

  /** Through every stage up to approved. */
  async function approved(s: Awaited<ReturnType<typeof setup>>, price = '100') {
    const inv = await submitted(s, undefined, price);
    await c.supplierInvoices.pickUp(staff('clerk'), inv.id);
    const linked = await c.supplierInvoices.autoLink(staff('clerk'), inv.id);
    expect(linked.complete).toBe(true);
    expect(await c.supplierInvoices.runMatch(staff('checker'), inv.id)).toMatchObject({ ok: true });
    await c.supplierInvoices.sendForApproval(staff('checker'), inv.id);
    await c.supplierInvoices.approve(staff('boss'), inv.id);
    return inv;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    ({ drizzleDb: db } = await import('@/server/db/drizzle/client'));
    schema = await import('@/server/db/drizzle/schema');
    const { getContainer } = await import('@/server/di/container');
    c = getContainer();
    const [company] = await db
      .insert(schema.companySettings)
      .values({ legalName: 'VP', tradingName: 'VP', email: 'buyer@vp.test', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P' })
      .returning();
    companyId = required(company).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    await c.finance.setup.applyTemplate(staff('reviewer'), 'kenya', { fiscalYearStart: '2026-01-01' });
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    await c.finance.paymentMethods.seedStandard(staff('reviewer'));
    const methods = await db.select().from(schema.paymentMethods).where(eq(schema.paymentMethods.companyId, companyId));
    for (const m of methods) await db.update(schema.paymentMethods).set({ usableFor: ['customer_receipt', 'vendor_payment'] }).where(eq(schema.paymentMethods.id, m.id));
    cash = required(methods.find((m) => m.kind === 'cash')).id;
    transfer = required(methods.find((m) => m.kind === 'bank_transfer')).id;
    await db.update(schema.financeSettings).set({ inventoryGlGoLive: '2026-01-01' }).where(eq(schema.financeSettings.companyId, companyId));
    const accounts = await db.select().from(schema.glAccounts).where(eq(schema.glAccounts.companyId, companyId));
    inputTax = required(accounts.find((a) => a.no === '1410')).id;
    await db.insert(schema.vendorSettings).values({ companyId, inputTaxAccountId: inputTax }).onConflictDoUpdate({ target: schema.vendorSettings.companyId, set: { inputTaxAccountId: inputTax } });
    const probe = await product(0, '1');
    const [p] = await db.select({ unitId: schema.products.baseUnitId }).from(schema.products).where(eq(schema.products.id, probe));
    const [u] = await db.select({ code: schema.unitsOfMeasure.code, name: schema.unitsOfMeasure.name }).from(schema.unitsOfMeasure).where(eq(schema.unitsOfMeasure.id, required(p).unitId));
    unit = required(u);
  });


  const voucherHeader = (vendorId: string, methodId: string, over: Partial<VoucherHeaderForm> = {}): VoucherHeaderForm => ({ kind: 'invoices', vendorId, methodId, narration: '', advanceId: '', ...over });
  const alloc = (purchaseInvoiceId: string, amount: string): AllocationForm => ({ purchaseInvoiceId, amount });

  /** A booked invoice for 4 units at the price given (tax 16%): the amount owed is 4 × price × 1.16. */
  async function booked(price = '100') {
    const s = await setup({ qty: '4', discount: '0' });
    const inv = await approved(s, price);
    await c.invoicePosting.post(staff('finance'), inv.id);
    const [p] = await db.select().from(schema.purchaseInvoices).where(eq(schema.purchaseInvoices.supplierInvoiceId, inv.id));
    return { ...s, inv, pinv: required(p) };
  }

  const remaining = async (entryId: string) => required((await db.select().from(schema.vendorLedgerEntries).where(eq(schema.vendorLedgerEntries.id, entryId)))[0]).remainingAmount;
  const voucher = async (id: string) => required((await db.select().from(schema.vendorPaymentVouchers).where(eq(schema.vendorPaymentVouchers.id, id)))[0]);

  /** From draft to approved by a second person. */
  async function approvedVoucher(vendorId: string, methodId: string, allocations: AllocationForm[]) {
    const { id } = await c.vendorPayments.saveDraft(staff('clerk'), null, voucherHeader(vendorId, methodId), allocations);
    await c.vendorPayments.submit(staff('clerk'), id);
    const { number } = await c.vendorPayments.approve(staff('boss'), id);
    return { id, number };
  }

  describe('an approval workflow (the approval engine)', () => {
    it('holds a payment voucher for the inbox: no direct approval or cancel, a release approves it', async () => {
      const b = await booked();
      const actor = { type: 'user' as const, id: 'wf-test' };
      const reason = { code: 'POLICY_CHANGE' };
      const mk = async (label: string) => required((await db.insert(schema.users).values({ email: `${label}-${randomUUID()}@example.test`, passwordHash: 'x', name: label, role: 'manager' }).returning())[0]).id;
      const [owner, clerk] = await Promise.all([mk('boss'), mk('clerk')]);
      await c.approvalConfig.saveProfile(companyId, { userId: owner, limits: [] }, actor, reason);
      const wf = await c.approvalConfig.createWorkflow(companyId, { code: `W-${randomUUID().slice(0, 8)}`, name: 'Payment test', trigger: 'vendor.payment' }, actor);
      await c.approvalConfig.saveDraft(companyId, wf.id, { conditions: { op: 'eq', field: 'vendor.id', value: b.v.vendorId }, steps: [{ sequence: 1, name: 'Boss', approver: { type: 'user', userId: owner } }] } as never, actor);
      await c.approvalConfig.publish(companyId, wf.id, actor, reason);
      const { id } = await c.vendorPayments.saveDraft(staff(clerk), null, voucherHeader(b.v.vendorId, transfer), [alloc(b.pinv.id, '200')]);
      await c.vendorPayments.submit(staff(clerk), id);
      expect((await voucher(id)).status).toBe('pending_approval');
      expect(await codeOf(c.vendorPayments.approve(staff('boss'), id))).toBe('USE_APPROVALS');
      expect(await codeOf(c.vendorPayments.cancel(staff(clerk), id, 'Changed my mind'))).toBe('USE_APPROVALS');
      const entry = required((await c.approvals.forDocument(companyId, 'vendor_payment', id)).flatMap((r) => r.entries).find((e) => e.status === 'open'));
      await db.transaction(async (tx) => await c.approvals.approve(entry.id, owner, null, tx));
      const done = await voucher(id);
      expect(done.status).toBe('approved');
      expect(done.approvedBy).toBe(owner);
      expect(done.number).toMatch(/\d/);
    });
  });

  describe('writing a voucher', () => {
    it('is for open invoices of a vendor within what is open, with a way of paying set up for vendors', async () => {
      const b = await booked();
      expect(b.pinv.total).toBe('464.00');
      const items = await c.vendorPayments.openItems(companyId, b.v.vendorId);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ remaining: '464.00', available: '464.00' });
      const h = voucherHeader(b.v.vendorId, cash);
      expect(await codeOf(c.vendorPayments.saveDraft(staff('clerk'), null, h, [alloc(b.pinv.id, '464.01')]))).toBe('INVALID');
      expect(await codeOf(c.vendorPayments.saveDraft(staff('clerk'), null, h, []))).toBe('INVALID');
      expect(await codeOf(c.vendorPayments.saveDraft(staff('clerk'), null, voucherHeader(b.v.vendorId, randomUUID()), [alloc(b.pinv.id, '10')]))).toBe('METHOD_INVALID');
      await db.update(schema.vendors).set({ block: 'payment' }).where(eq(schema.vendors.id, b.v.vendorId));
      expect(await codeOf(c.vendorPayments.saveDraft(staff('clerk'), null, h, [alloc(b.pinv.id, '10')]))).toBe('VENDOR_BLOCKED');
      await db.update(schema.vendors).set({ block: 'none' }).where(eq(schema.vendors.id, b.v.vendorId));
      const first = await c.vendorPayments.saveDraft(staff('clerk'), null, h, [alloc(b.pinv.id, '400')]);
      expect(first.amount).toBe('400.00');
      // Another voucher cannot claim what the first one holds.
      const other = await c.vendorPayments.openItems(companyId, b.v.vendorId);
      expect(other[0]).toMatchObject({ held: '400.00', available: '64.00' });
      expect(await codeOf(c.vendorPayments.saveDraft(staff('clerk'), null, h, [alloc(b.pinv.id, '100')]))).toBe('INVALID');
      // Editing the first one frees and re-takes its own claim.
      await c.vendorPayments.saveDraft(staff('clerk'), first.id, h, [alloc(b.pinv.id, '464')]);
      expect((await voucher(first.id)).amount).toBe('464.00');
    });

    it('is approved by another person, gets its number then, and fixes the vendor’s bank account', async () => {
      const b = await booked();
      const { id } = await c.vendorPayments.saveDraft(staff('clerk'), null, voucherHeader(b.v.vendorId, transfer), [alloc(b.pinv.id, '464')]);
      expect((await voucher(id)).number).toBeNull();
      expect(await codeOf(c.vendorPayments.approve(staff('boss'), id))).toBe('WRONG_STATE');
      await c.vendorPayments.submit(staff('clerk'), id);
      expect(await codeOf(c.vendorPayments.approve(staff('clerk'), id))).toBe('FOUR_EYES');
      expect(await codeOf(db.update(schema.vendorPaymentVouchers).set({ status: 'approved', approvedBy: 'clerk' }).where(eq(schema.vendorPaymentVouchers.id, id)))).toBe('23514');
      await c.vendorPayments.sendBack(staff('boss'), id, 'Wrong amount');
      expect((await voucher(id)).sendBackReason).toBe('Wrong amount');
      await c.vendorPayments.submit(staff('clerk'), id);
      const { number } = await c.vendorPayments.approve(staff('boss'), id);
      expect(number).toMatch(/^VPV-\d{4}-\d{5}$/);
      const v = await voucher(id);
      expect(v.destination).toMatch(/ending \d{4}$/);
      expect(v.vendorBankAccountId).not.toBeNull();
      // A way of paying that needs no bank account fixes none.
      const c2 = await booked();
      const cashOne = await approvedVoucher(c2.v.vendorId, cash, [alloc(c2.pinv.id, '464')]);
      expect((await voucher(cashOne.id)).vendorBankAccountId).toBeNull();
      // A voucher can be cancelled until it is paid, with a reason.
      expect(await codeOf(c.vendorPayments.cancel(staff('clerk'), cashOne.id, ' '))).toBe('NOTE_REQUIRED');
      await c.vendorPayments.cancel(staff('clerk'), cashOne.id, 'Paid another way');
      expect((await voucher(cashOne.id)).status).toBe('cancelled');
      expect(await codeOf(c.vendorPayments.pay(staff('till'), cashOne.id, { reference: 'X', paidOn: TODAY }))).toBe('WRONG_STATE');
    });
  });

  describe('paying', () => {
    it('books the payment, sets it against the invoice in the vendor ledger and leaves nothing open; the ledger stays in step', async () => {
      const b = await booked();
      const v1 = await approvedVoucher(b.v.vendorId, transfer, [alloc(b.pinv.id, '200')]);
      expect(await codeOf(c.vendorPayments.pay(staff('till'), v1.id, { reference: ' ', paidOn: TODAY }))).toBe('REFERENCE_REQUIRED');
      expect(await codeOf(c.vendorPayments.pay(staff('till'), v1.id, { reference: 'TRX1', paidOn: '2999-01-01' }))).toBe('INVALID');
      const paid = await c.vendorPayments.pay(staff('till'), v1.id, { reference: 'TRX-001', paidOn: TODAY });
      expect(paid.number).toBe(v1.number);
      const v = await voucher(v1.id);
      expect(v).toMatchObject({ status: 'paid', paymentReference: 'TRX-001' });
      const entries = await db.select().from(schema.glEntries).where(eq(schema.glEntries.registerId, required(v.registerId)));
      const accounts = await db.select().from(schema.glAccounts).where(eq(schema.glAccounts.companyId, companyId));
      const no = (id: string) => accounts.find((a) => a.id === id)?.no;
      const debit = entries.find((e) => Number(e.debit) > 0);
      const credit = entries.find((e) => Number(e.credit) > 0);
      expect([no(required(debit).accountId), Number(required(debit).debit), Number(required(credit).credit)]).toEqual(['2110', 200, 200]);
      expect(await remaining(b.pinv.ledgerEntryId)).toBe('264.00');
      expect(await remaining(required(v.ledgerEntryId))).toBe('0.00');
      expect(await codeOf(c.vendorPayments.pay(staff('till'), v1.id, { reference: 'TRX-002', paidOn: TODAY }))).toBe('WRONG_STATE');
      expect(await codeOf(db.update(schema.vendorPaymentVouchers).set({ amount: '1' }).where(eq(schema.vendorPaymentVouchers.id, v1.id)))).toBe('23001');
      expect(await codeOf(db.delete(schema.vendorPaymentVouchers).where(eq(schema.vendorPaymentVouchers.id, v1.id)))).toBe('23001');
      expect(await codeOf(db.delete(schema.vendorPaymentVoucherLines).where(eq(schema.vendorPaymentVoucherLines.voucherId, v1.id)))).toBe('23001');
      // The rest, in a second voucher.
      const v2 = await approvedVoucher(b.v.vendorId, cash, [alloc(b.pinv.id, '264')]);
      await c.vendorPayments.pay(staff('till'), v2.id, { reference: 'CASH-1', paidOn: TODAY });
      expect(await remaining(b.pinv.ledgerEntryId)).toBe('0.00');
      expect(await c.vendorPayments.openItems(companyId, b.v.vendorId)).toHaveLength(0);
      expect(await c.finance.vendorLedger.drift(companyId)).toEqual([]);
      // The vendor sees what was paid and for which invoices.
      const remit = await c.vendorPayments.remittances(b.v.vendorId);
      expect(remit.rows.map((r) => r.reference).sort()).toEqual(['CASH-1', 'TRX-001']);
      expect(remit.rows.find((r) => r.reference === 'TRX-001')?.invoices).toEqual([{ vendorInvoiceNo: b.inv.no, amount: '200.00' }]);
    });

    it('needs a third person from the configured value, and a blocked vendor or a lapsed bank account stops the money', async () => {
      const b = await booked();
      await c.purchaseOrders.saveSettings(staff('admin'), { rfqRequiredAbove: '', amendmentTolerancePercent: '0', paymentThreeEyesAbove: '400' });
      const v = await approvedVoucher(b.v.vendorId, transfer, [alloc(b.pinv.id, '464')]);
      expect((await voucher(v.id)).needsThree).toBe(true);
      expect(await codeOf(c.vendorPayments.pay(staff('clerk'), v.id, { reference: 'T1', paidOn: TODAY }))).toBe('THREE_PEOPLE');
      expect(await codeOf(c.vendorPayments.pay(staff('boss'), v.id, { reference: 'T1', paidOn: TODAY }))).toBe('THREE_PEOPLE');
      expect(await codeOf(db.update(schema.vendorPaymentVouchers).set({ status: 'paid', paidBy: 'boss', paymentReference: 'x', registerId: randomUUID(), ledgerEntryId: randomUUID() }).where(eq(schema.vendorPaymentVouchers.id, v.id)))).toBe('23514');
      await db.update(schema.vendors).set({ block: 'all' }).where(eq(schema.vendors.id, b.v.vendorId));
      expect(await codeOf(c.vendorPayments.pay(staff('till'), v.id, { reference: 'T1', paidOn: TODAY }))).toBe('VENDOR_BLOCKED');
      await db.update(schema.vendors).set({ block: 'none' }).where(eq(schema.vendors.id, b.v.vendorId));
      const [vb] = await db.select().from(schema.vendorBankAccounts).where(eq(schema.vendorBankAccounts.vendorId, b.v.vendorId));
      await db.update(schema.vendorBankAccounts).set({ status: 'retired' }).where(eq(schema.vendorBankAccounts.id, required(vb).id));
      expect(await codeOf(c.vendorPayments.pay(staff('till'), v.id, { reference: 'T1', paidOn: TODAY }))).toBe('DESTINATION_CHANGED');
      await db.update(schema.vendorBankAccounts).set({ status: 'active' }).where(eq(schema.vendorBankAccounts.id, required(vb).id));
      expect(await codeOf(c.vendorPayments.pay(staff('till'), v.id, { reference: 'T1', paidOn: TODAY }))).toBe('OK');
      await c.purchaseOrders.saveSettings(staff('admin'), { rfqRequiredAbove: '', amendmentTolerancePercent: '0', paymentThreeEyesAbove: '100000' });
    });

    it('holds a flagged payment for three people: a large payment to a new vendor, or a bank account another vendor also uses, unless the rule is off', async () => {
      const base = { rfqRequiredAbove: '', amendmentTolerancePercent: '0', paymentThreeEyesAbove: '0' };
      await c.purchaseOrders.saveSettings(staff('admin'), { ...base, watchNewVendorAmount: '400', watchNewVendorDays: '30', holdFlaggedPayments: true });
      const big = await booked();
      const flagged = await approvedVoucher(big.v.vendorId, transfer, [alloc(big.pinv.id, '464')]);
      expect((await voucher(flagged.id)).needsThree).toBe(true);
      const events = await db.select().from(schema.vendorPaymentEvents).where(eq(schema.vendorPaymentEvents.voucherId, flagged.id));
      expect(JSON.stringify(events.find((e) => e.event === 'approved')?.data)).toMatch(/a vendor added/);
      // Small payments to the same new vendor are not flagged.
      await c.purchaseOrders.saveSettings(staff('admin'), { ...base, watchNewVendorAmount: '1000000' });
      const small = await booked();
      expect((await voucher((await approvedVoucher(small.v.vendorId, transfer, [alloc(small.pinv.id, '100')])).id)).needsThree).toBe(false);
      // A bank account shared with another vendor flags the payment whatever the amount.
      const [mine] = await db.select().from(schema.vendorBankAccounts).where(eq(schema.vendorBankAccounts.vendorId, small.v.vendorId));
      const other = await booked();
      await db.update(schema.vendorBankAccounts).set({ accountHash: required(mine).accountHash }).where(eq(schema.vendorBankAccounts.vendorId, other.v.vendorId));
      expect((await voucher((await approvedVoucher(other.v.vendorId, transfer, [alloc(other.pinv.id, '100')])).id)).needsThree).toBe(true);
      // With the rule off nothing is held.
      await c.purchaseOrders.saveSettings(staff('admin'), { ...base, holdFlaggedPayments: false });
      const third = await booked();
      const [theirs] = await db.select().from(schema.vendorBankAccounts).where(eq(schema.vendorBankAccounts.vendorId, third.v.vendorId));
      await db.update(schema.vendorBankAccounts).set({ accountHash: required(mine).accountHash }).where(eq(schema.vendorBankAccounts.id, required(theirs).id));
      expect((await voucher((await approvedVoucher(third.v.vendorId, transfer, [alloc(third.pinv.id, '464')])).id)).needsThree).toBe(false);
      expect(await codeOf(c.purchaseOrders.saveSettings(staff('admin'), { ...base, watchNewVendorDays: '4000' }))).toBe('INVALID');
      await c.purchaseOrders.saveSettings(staff('admin'), { rfqRequiredAbove: '', amendmentTolerancePercent: '0', paymentThreeEyesAbove: '100000', watchNewVendorAmount: '100000', watchNewVendorDays: '30', holdFlaggedPayments: true });
    });
  });

  describe('the bank', () => {
    it('shows the payment in the bank’s own ledger, is matched to the statement line that quotes its reference, and a reversal puts the money back there', async () => {
      const b = await booked();
      const v = await approvedVoucher(b.v.vendorId, transfer, [alloc(b.pinv.id, '464')]);
      const ref = `EFT${String(Date.now()).slice(-8)}`;
      await c.vendorPayments.pay(staff('till'), v.id, { reference: ref, paidOn: new Date().toISOString().slice(0, 10) });
      const entries = await db.select().from(schema.bankLedgerEntries).where(eq(schema.bankLedgerEntries.documentId, v.id));
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ documentType: 'vendor_payment', documentNo: v.number, amount: '-464.0000' });
      const row = required((await db.select().from(schema.vendorPaymentVouchers).where(eq(schema.vendorPaymentVouchers.id, v.id)))[0]);
      const gl = await db.select().from(schema.glEntries).where(eq(schema.glEntries.registerId, required(row.registerId)));
      expect(gl.some((e) => e.sourceLedger === 'bank' && e.sourceEntryId === required(entries[0]).bankAccountId && Number(e.credit) === 464)).toBe(true);
      // The statement shows the same money leaving, quoting our reference: matched by itself.
      const today = new Date().toISOString().slice(0, 10);
      const dmy = today.split('-').reverse().join('/');
      const text = `Date,Narration,Ref,In,Out,Balance\n${dmy},Transfer to vendor,${ref},,464.00,\n`;
      const out = await c.finance.bankStatements.import(staff('reviewer'), { bankAccountId: required(entries[0]).bankAccountId, fileName: `vp${run}.csv`, text, format: 'csv', mapping: { headerRow: 1, date: 'Date', description: ['Narration'], reference: 'Ref', paidIn: 'In', withdrawn: 'Out', balance: 'Balance' }, saveFormat: false });
      expect(out).toMatchObject({ lines: 1, autoMatched: 1 });
      const events = await db.select().from(schema.vendorPaymentEvents).where(eq(schema.vendorPaymentEvents.voucherId, v.id));
      expect(events.map((e) => e.event)).toContain('bank_matched');
      // Reversing writes the opposite entry to the bank's ledger.
      await c.vendorPayments.reverse(staff('boss'), v.id, 'Sent to the wrong vendor');
      const after = await db.select().from(schema.bankLedgerEntries).where(eq(schema.bankLedgerEntries.documentId, v.id));
      expect(after.map((e) => e.documentType).sort()).toEqual(['vendor_payment', 'vendor_payment_reversal']);
      expect(after.find((e) => e.documentType === 'vendor_payment_reversal')).toMatchObject({ amount: '464.0000', reversesEntryId: required(entries[0]).id });
    });
  });

  describe('reversing', () => {
    it('opens the invoice again and reverses the journal, with a reason, once', async () => {
      const b = await booked();
      const v = await approvedVoucher(b.v.vendorId, cash, [alloc(b.pinv.id, '464')]);
      expect(await codeOf(c.vendorPayments.reverse(staff('boss'), v.id, 'x'))).toBe('NOT_PAID');
      await c.vendorPayments.pay(staff('till'), v.id, { reference: 'CASH-9', paidOn: TODAY });
      expect(await remaining(b.pinv.ledgerEntryId)).toBe('0.00');
      expect(await codeOf(c.vendorPayments.reverse(staff('boss'), v.id, ' '))).toBe('NOTE_REQUIRED');
      expect(await codeOf(c.vendorPayments.reverse(staff('boss'), v.id, 'Paid twice by mistake'))).toBe('OK');
      expect(await remaining(b.pinv.ledgerEntryId)).toBe('464.00');
      const row = await voucher(v.id);
      expect(row.status).toBe('reversed');
      expect(await remaining(required(row.ledgerEntryId))).toBe('0.00');
      expect(await codeOf(c.vendorPayments.reverse(staff('boss'), v.id, 'again'))).toBe('NOT_PAID');
      const net = await db.execute<{ net: string }>(sql`SELECT COALESCE(SUM(base_debit - base_credit), 0)::text AS net FROM gl_entries WHERE register_id IN (${required(row.registerId)}::uuid, ${required(row.reversalRegisterId)}::uuid)`);
      expect(Number([...net][0]?.net)).toBe(0);
      expect(await c.finance.vendorLedger.drift(companyId)).toEqual([]);
      expect((await c.vendorPayments.openItems(companyId, b.v.vendorId))[0]?.available).toBe('464.00');
      expect((await c.vendorPayments.remittances(b.v.vendorId)).rows).toHaveLength(0);
    });
  });

  describe('advances', () => {
    it('pays an approved advance to the prepayments account, and sets it against the booked invoice of the same order', async () => {
      const v = await approvedVendor();
      const prod = await product(0, '10');
      const order = await sentOrder(v, [stockLine(prod, { quantity: '4', discountPercent: '0', unitPrice: '100' })], { confirm: true, advance: true });
      const adv = await c.advances.create(staff('buyer'), order.id, { amount: '300', dueDate: '', reason: 'Deposit' });
      await c.advances.submit(staff('buyer'), adv.id);
      await c.advances.approve(staff('boss'), adv.id);
      expect((await c.vendorPayments.advancesToPay(companyId, v.vendorId)).map((a) => a.id)).toEqual([adv.id]);
      const { id } = await c.vendorPayments.saveDraft(staff('clerk'), null, voucherHeader(v.vendorId, cash, { kind: 'advance', advanceId: adv.id }), []);
      expect((await voucher(id)).amount).toBe('300.00');
      expect(await codeOf(c.vendorPayments.saveDraft(staff('clerk'), null, voucherHeader(v.vendorId, cash, { kind: 'advance', advanceId: adv.id }), []))).toBe('ALREADY_LIVE');
      expect((await c.vendorPayments.advancesToPay(companyId, v.vendorId))).toHaveLength(0);
      await c.vendorPayments.submit(staff('clerk'), id);
      await c.vendorPayments.approve(staff('boss'), id);
      await c.vendorPayments.pay(staff('till'), id, { reference: 'ADV-1', paidOn: TODAY });
      const row = await voucher(id);
      const entries = await db.select().from(schema.glEntries).where(eq(schema.glEntries.registerId, required(row.registerId)));
      const accounts = await db.select().from(schema.glAccounts).where(eq(schema.glAccounts.companyId, companyId));
      expect(entries.map((e) => accounts.find((a) => a.id === e.accountId)?.no).sort()).toContain('1430');
      const [doc] = await db.select().from(schema.vendorAdvancePayments).where(eq(schema.vendorAdvancePayments.id, adv.id));
      expect(doc).toMatchObject({ status: 'paid', voucherId: id });
      expect(await remaining(required(row.ledgerEntryId))).toBe('-300.00');
      // Goods arrive and the invoice is booked: the advance is set against it.
      await receive(order.id, [rl(required(order.lines[0]), '4')], dn());
      const s = { v, prod, order, line: required(order.lines[0]), note: required((await db.select().from(schema.rgns).where(eq(schema.rgns.poId, order.id)))[0]).deliveryNoteNo };
      const inv = await approved(s);
      await c.invoicePosting.post(staff('finance'), inv.id);
      const [pinv] = await db.select().from(schema.purchaseInvoices).where(eq(schema.purchaseInvoices.supplierInvoiceId, inv.id));
      // Once part of the advance is set against an invoice, the voucher that paid it can no longer be reversed.
      expect(await c.vendorPayments.applyAdvance(staff('finance'), required(pinv).id)).toEqual({ appliedCents: 30000 });
      expect(await remaining(required(pinv).ledgerEntryId)).toBe('164.00');
      expect(await remaining(required(row.ledgerEntryId))).toBe('0.00');
      expect((await db.select().from(schema.vendorAdvancePayments).where(eq(schema.vendorAdvancePayments.id, adv.id)))[0]?.status).toBe('applied');
      expect(await codeOf(c.vendorPayments.applyAdvance(staff('finance'), required(pinv).id))).toBe('NO_ADVANCE');
      expect(await codeOf(c.vendorPayments.reverse(staff('boss'), id, 'x'))).toBe('ADVANCE_APPLIED');
      expect(await c.finance.vendorLedger.drift(companyId)).toEqual([]);
    });

    it('can reverse an advance that was not applied, which gives the advance back as approved', async () => {
      const v = await approvedVendor();
      const prod = await product(0, '10');
      const order = await sentOrder(v, [stockLine(prod, { quantity: '4', discountPercent: '0' })], { confirm: true, advance: true });
      const adv = await c.advances.create(staff('buyer'), order.id, { amount: '100', dueDate: '', reason: 'Deposit' });
      await c.advances.submit(staff('buyer'), adv.id);
      await c.advances.approve(staff('boss'), adv.id);
      const w = await approvedVoucher(v.vendorId, cash, []).catch(() => null);
      expect(w).toBeNull();
      const { id } = await c.vendorPayments.saveDraft(staff('clerk'), null, voucherHeader(v.vendorId, cash, { kind: 'advance', advanceId: adv.id }), []);
      await c.vendorPayments.submit(staff('clerk'), id);
      await c.vendorPayments.approve(staff('boss'), id);
      await c.vendorPayments.pay(staff('till'), id, { reference: 'ADV-2', paidOn: TODAY });
      await c.vendorPayments.reverse(staff('boss'), id, 'Paid to the wrong vendor');
      const [doc] = await db.select().from(schema.vendorAdvancePayments).where(eq(schema.vendorAdvancePayments.id, adv.id));
      expect(doc).toMatchObject({ status: 'approved', voucherId: null });
      expect((await c.vendorPayments.advancesToPay(companyId, v.vendorId)).map((a) => a.id)).toEqual([adv.id]);
    });
  });

  describe('what we owe', () => {
    it('ages open invoices by due date and lists a vendor’s statement', async () => {
      const b = await booked();
      const asOf = TODAY;
      const report = await c.payablesReports.ageing(companyId, asOf);
      const line = report.lines.find((l) => l.vendorId === b.v.vendorId);
      expect(line?.owedCents).toBe(46400);
      expect(Object.values(line?.buckets ?? {}).reduce((s, x) => s + x, 0)).toBe(46400);
      const later = await c.payablesReports.ageing(companyId, new Date(Date.now() + 100 * 86_400_000).toISOString().slice(0, 10));
      expect(later.lines.find((l) => l.vendorId === b.v.vendorId)?.buckets.d90_plus).toBe(46400);
      const st = required(await c.payablesReports.statement(companyId, b.v.vendorId));
      expect(st.balance).toBe('464.00');
      expect(st.entries[0]).toMatchObject({ documentType: 'invoice', externalNo: b.inv.no, remaining: '464.00' });
      expect(await c.payablesReports.statement(companyId, randomUUID())).toBeNull();
    });
  });

  describe('a payment on account', () => {
    it('needs a reason and an amount, waits on the vendor’s account, is set against a later invoice, and cannot be reversed once it has been', async () => {
      const b = await booked();
      const base = { kind: 'on_account' as const, vendorId: b.v.vendorId, methodId: cash, advanceId: '' };
      expect(await codeOf(c.vendorPayments.saveDraft(staff('clerk'), null, { ...base, narration: ' ', amount: '300' }, []))).toBe('INVALID');
      expect(await codeOf(c.vendorPayments.saveDraft(staff('clerk'), null, { ...base, narration: 'Deposit', amount: '0' }, []))).toBe('INVALID');
      const { id } = await c.vendorPayments.saveDraft(staff('clerk'), null, { ...base, narration: 'Deposit for next season', amount: '300' }, []);
      expect(await db.select().from(schema.vendorPaymentVouchers).where(eq(schema.vendorPaymentVouchers.id, id)).then((r) => r[0])).toMatchObject({ kind: 'on_account', amount: '300.00', cashAmount: '300.00' });
      await c.vendorPayments.submit(staff('clerk'), id);
      await c.vendorPayments.approve(staff('boss'), id);
      await c.vendorPayments.pay(staff('till'), id, { reference: 'OA-1', paidOn: new Date().toISOString().slice(0, 10) });
      const row = required((await db.select().from(schema.vendorPaymentVouchers).where(eq(schema.vendorPaymentVouchers.id, id)))[0]);
      expect(await remaining(required(row.ledgerEntryId))).toBe('-300.00');
      const credits = await c.vendorPayments.openCredits(companyId, b.v.vendorId);
      expect(credits.map((x) => [x.documentNo, x.openCents])).toEqual([[row.number, 30000]]);
      // The books agree even with money paid and nothing yet to set it against.
      expect((await c.payablesReports.reconcile(companyId)).ok).toBe(true);
      expect((await c.payablesReports.ageing(companyId, new Date().toISOString().slice(0, 10))).lines.find((l) => l.vendorId === b.v.vendorId)?.unappliedCents).toBe(-30000);
      // Reversing an unused payment on account is allowed...
      const second = await c.vendorPayments.saveDraft(staff('clerk'), null, { ...base, narration: 'Wrong vendor', amount: '50' }, []);
      await c.vendorPayments.submit(staff('clerk'), second.id);
      await c.vendorPayments.approve(staff('boss'), second.id);
      await c.vendorPayments.pay(staff('till'), second.id, { reference: 'OA-2', paidOn: new Date().toISOString().slice(0, 10) });
      await c.vendorPayments.reverse(staff('boss'), second.id, 'Meant for another vendor');
      expect((await c.vendorPayments.openCredits(companyId, b.v.vendorId)).map((x) => x.openCents)).toEqual([30000]);
      // ...and the first is set against the invoice, the invoice keeping 164.00.
      expect(await c.vendorPayments.applyCredit(staff('finance'), b.pinv.id)).toEqual({ appliedCents: 30000 });
      expect(await remaining(b.pinv.ledgerEntryId)).toBe('164.00');
      expect(await remaining(required(row.ledgerEntryId))).toBe('0.00');
      expect(await codeOf(c.vendorPayments.applyCredit(staff('finance'), b.pinv.id))).toBe('NO_CREDIT');
      expect(await codeOf(c.vendorPayments.reverse(staff('boss'), id, 'Too late'))).toBe('ON_ACCOUNT_APPLIED');
      expect((await c.payablesReports.reconcile(companyId)).ok).toBe(true);
      expect(await c.finance.vendorLedger.drift(companyId)).toEqual([]);
    });
  });

  describe('the check against the books', () => {
    it('agrees after booking, paying, an advance and a reversal, finds a ledger entry the books do not have, and keeps the result', async () => {
      const b = await booked();
      const v = await approvedVoucher(b.v.vendorId, cash, [alloc(b.pinv.id, '200')]);
      await c.vendorPayments.pay(staff('till'), v.id, { reference: 'CHK-1', paidOn: new Date().toISOString().slice(0, 10) });
      const r = await c.payablesReports.reconcile(companyId);
      expect(r.drift).toEqual([]);
      expect(r.rows.filter((x) => x.diffCents !== 0)).toEqual([]);
      expect(r.ok).toBe(true);
      const payables = r.rows.find((x) => x.purpose === 'payables');
      expect(payables?.accountNo).toBe('2110');
      expect(payables?.glCents).toBe(payables?.ledgerCents);
      // An invoice in the vendor ledger that was never booked to the books is a defect.
      await db.transaction(async (tx) => {
        await c.finance.vendorLedger.addEntry(tx, { companyId, vendorId: b.v.vendorId, documentType: 'invoice', documentNo: `STRAY-${run}`, externalDocumentNo: `STRAY-${run}`, amountCents: 12345, currency: 'KES', postingDate: new Date().toISOString().slice(0, 10) });
      });
      const bad = await c.payablesReports.runCheck(companyId, 'tester');
      expect(bad.ok).toBe(false);
      expect(bad.differences).toBe(1);
      expect(bad.rows.find((x) => x.purpose === 'payables')?.diffCents).toBe(-12345);
      const last = required(await c.payablesReports.lastCheck(companyId));
      expect(last).toMatchObject({ ok: false, ranBy: 'tester', differences: 1 });
    });
  });
});
