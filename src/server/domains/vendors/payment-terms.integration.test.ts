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

describe.skipIf(!has(url))('withholding, discounts and tolerance (database)', () => {
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
    const [u] = await db.insert(schema.users).values({ email: `wt${String(seq)}.${run}@example.test`, passwordHash: 'x', name: 'Owner', role: 'vendor' }).returning();
    const vendorId = await c.vendors.registerBusiness({ companyId, userId: required(u).id, legalName: `WT Vendor ${run} ${String(seq)}`, email: `wt${String(seq)}.${run}@example.test`, phone: null });
    const a: PortalActor = { vendorId, userId: required(u).id, portalRole: 'owner' };
    const p = c.vendorProfile;
    const profile: ProfileData = { ...emptyProfile(), country: 'Kenya', description: 'We supply solar panels and inverters to businesses.', physicalStreet: '1 Mombasa Road', physicalCity: 'Nairobi', phone: '+254 700 000 000' };
    await p.saveProfile(a, profile);
    await p.saveBusiness(a, { ...emptyBusiness(), registrationNo: 'CPR/2012/12345', registrationDate: '2012-03-04', taxId: `G${String(Date.now()).slice(-9)}${String(seq % 10)}` });
    await p.addDirector(a, { name: 'Wanjiru Kamau', idType: 'national_id', idNumber: '12345678', sharePercent: '100' });
    await p.addBank(a, { bankName: 'KCB', branch: 'Moi Avenue', accountName: 'Acme Ltd', accountNumber: `0123${String(seq).padStart(6, '0')}`, swift: '' });
    await p.saveFinancial(a, { ...emptyFinancial(), offeredPaymentTermDays: '30' });
    await p.saveContacts(a, [{ name: 'Wanjiru Kamau', role: 'management', email: `wtw${String(seq)}.${run}@acme.test`, phone: '0700000000', isPrimary: true }]);
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
    await db.insert(schema.products).values({ id, sku: `WT-${run}-${String(prodSeq)}`.toUpperCase(), stockCode: `WTS-${run}-${String(prodSeq)}`.toUpperCase(), name: `Receiving ${String(prodSeq)}`, slug: `wt-${randomUUID()}`, itemTypeId, price: '999', costPrice: cost, stockQuantity: stock });
    return id;
  }

  /** A sent order with the lines given, for a qualified vendor; returns the order and its line ids. */
  async function sentOrder(v: PortalActor, lines: PoLineForm[], over: { currency?: string; confirm?: boolean; advance?: boolean } = {}) {
    catSeq += 1;
    const cat = await c.categories.save(companyId, null, { ...emptyCategory(), code: `WT${String(catSeq)}_${run}`.toUpperCase(), name: `WT category ${String(catSeq)} ${run}` });
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
      .values({ legalName: 'WT', tradingName: 'WT', email: 'buyer@wt.test', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P' })
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

  /** A booked invoice for 4 units at the price given (tax 16%): the amount owed is 4 × price × 1.16. */
  async function booked(price = '100') {
    const s = await setup({ qty: '4', discount: '0' });
    const inv = await approved(s, price);
    await c.invoicePosting.post(staff('finance'), inv.id);
    const [p] = await db.select().from(schema.purchaseInvoices).where(eq(schema.purchaseInvoices.supplierInvoiceId, inv.id));
    return { ...s, inv, pinv: required(p) };
  }

  const remaining = async (entryId: string) => required((await db.select().from(schema.vendorLedgerEntries).where(eq(schema.vendorLedgerEntries.id, entryId)))[0]).remainingAmount;

  /** From draft to approved by a second person. */
  async function approvedVoucher(vendorId: string, methodId: string, allocations: AllocationForm[]) {
    const { id } = await c.vendorPayments.saveDraft(staff('clerk'), null, voucherHeader(vendorId, methodId), allocations);
    await c.vendorPayments.submit(staff('clerk'), id);
    const { number } = await c.vendorPayments.approve(staff('boss'), id);
    return { id, number };
  }


  const glLines = async (registerId: string) => {
    const accounts = await db.select().from(schema.glAccounts).where(eq(schema.glAccounts.companyId, companyId));
    const rows = await db.select().from(schema.glEntries).where(eq(schema.glEntries.registerId, registerId));
    return rows.map((e) => [accounts.find((a) => a.id === e.accountId)?.no, Number(e.debit), Number(e.credit)]).sort();
  };
  const today = new Date().toISOString().slice(0, 10);

  async function withCode(vendorId: string, over: { percent?: string; base?: string } = {}) {
    const code = await c.paymentTerms.saveCode(staff('admin'), null, { code: `W${String(++seq)}${run}`.slice(0, 20), name: 'Withholding on services', ratePercent: over.percent ?? '5', base: over.base ?? 'net', active: true });
    await c.paymentTerms.saveVendorTerms(staff('admin'), vendorId, { withholdingCodeId: code.id, earlyDiscountPercent: '', earlyDiscountDays: '' });
    return code.id;
  }

  describe('the rules', () => {
    it('keeps withholding codes as data, refusing nonsense and repeats, and gives each vendor its own terms', async () => {
      const ok = await c.paymentTerms.saveCode(staff('admin'), null, { code: `WHT-${run}`, name: 'Professional fees', ratePercent: '5', base: 'net', active: true });
      expect(ok.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(await codeOf(c.paymentTerms.saveCode(staff('admin'), null, { code: `wht-${run}`, name: 'Again', ratePercent: '5', base: 'net', active: true }))).toBe('DUPLICATE');
      expect(await codeOf(c.paymentTerms.saveCode(staff('admin'), null, { code: 'X', name: 'Bad', ratePercent: '0', base: 'net', active: true }))).toBe('INVALID');
      expect(await codeOf(c.paymentTerms.saveCode(staff('admin'), null, { code: 'X', name: 'Bad', ratePercent: '101', base: 'net', active: true }))).toBe('INVALID');
      expect(await codeOf(c.paymentTerms.saveCode(staff('admin'), null, { code: 'X', name: 'Bad', ratePercent: '5', base: 'weird', active: true }))).toBe('INVALID');
      const v = await approvedVendor();
      expect(await codeOf(c.paymentTerms.saveVendorTerms(staff('admin'), v.vendorId, { withholdingCodeId: ok.id, earlyDiscountPercent: '2', earlyDiscountDays: '10' }))).toBe('OK');
      expect(await codeOf(c.paymentTerms.saveVendorTerms(staff('admin'), v.vendorId, { withholdingCodeId: '', earlyDiscountPercent: '2', earlyDiscountDays: '0' }))).toBe('INVALID');
      expect(await codeOf(c.paymentTerms.saveVendorTerms(staff('admin'), v.vendorId, { withholdingCodeId: randomUUID(), earlyDiscountPercent: '', earlyDiscountDays: '' }))).toBe('INVALID');
      const terms = required(await c.paymentTerms.vendorTerms(companyId, v.vendorId));
      expect(terms).toMatchObject({ withholdingCodeId: ok.id, earlyDiscountPercent: '2.00', earlyDiscountDays: '10' });
      // The accounts payments post to come with the chart.
      const accounts = await c.paymentTerms.accounts(companyId);
      expect(accounts.withholdingPayable?.label).toMatch(/^2350 /);
      expect(accounts.paymentDiscount?.label).toMatch(/^4420 /);
      await c.paymentTerms.saveAccounts(staff('admin'), { payables: accounts.payables?.id ?? '', prepayments: accounts.prepayments?.id ?? '', paymentDiscount: accounts.paymentDiscount?.id ?? '', paymentTolerance: accounts.paymentTolerance?.id ?? '', withholdingPayable: accounts.withholdingPayable?.id ?? '', toleranceAmount: '5' });
      expect((await c.paymentTerms.accounts(companyId)).toleranceAmount).toBe('5.00');
      expect(await codeOf(c.paymentTerms.saveAccounts(staff('admin'), { payables: randomUUID(), prepayments: '', paymentDiscount: '', paymentTolerance: '', withholdingPayable: '', toleranceAmount: '5' }))).toBe('INVALID');
      expect(await codeOf(c.paymentTerms.saveAccounts(staff('admin'), { payables: '', prepayments: '', paymentDiscount: '', paymentTolerance: '', withholdingPayable: '', toleranceAmount: 'abc' }))).toBe('INVALID');
    });
  });

  describe('tax withheld', () => {
    it('is worked out at approval, kept off the cash, booked to its own account, and proved by a certificate', async () => {
      const b = await booked();
      await withCode(b.v.vendorId);
      const { id } = await c.vendorPayments.saveDraft(staff('clerk'), null, voucherHeader(b.v.vendorId, cash), [{ purchaseInvoiceId: b.pinv.id, amount: '464' }]);
      // Shown already on the draft, and fixed when approved.
      expect(await db.select().from(schema.vendorPaymentVouchers).where(eq(schema.vendorPaymentVouchers.id, id)).then((r) => r[0])).toMatchObject({ amount: '464.00', withholdingAmount: '20.00', cashAmount: '444.00' });
      await c.vendorPayments.submit(staff('clerk'), id);
      await c.vendorPayments.approve(staff('boss'), id);
      const approvedRow = required((await db.select().from(schema.vendorPaymentVouchers).where(eq(schema.vendorPaymentVouchers.id, id)))[0]);
      expect(approvedRow).toMatchObject({ withholdingAmount: '20.00', cashAmount: '444.00', discountAmount: '0.00' });
      const lines = await db.select().from(schema.vendorPaymentVoucherLines).where(eq(schema.vendorPaymentVoucherLines.voucherId, id));
      expect(lines[0]).toMatchObject({ withholdingBase: '400.00', withholding: '20.00' });
      await c.vendorPayments.pay(staff('till'), id, { reference: 'WHT-1', paidOn: today });
      const row = required((await db.select().from(schema.vendorPaymentVouchers).where(eq(schema.vendorPaymentVouchers.id, id)))[0]);
      expect(await glLines(required(row.registerId))).toEqual([['1110', 0, 444], ['2110', 464, 0], ['2350', 0, 20]].sort());
      expect(await remaining(b.pinv.ledgerEntryId)).toBe('0.00');
      expect(await remaining(required(row.ledgerEntryId))).toBe('0.00');
      const [cert] = await db.select().from(schema.withholdingCertificates).where(eq(schema.withholdingCertificates.voucherId, id));
      expect(cert).toMatchObject({ status: 'issued', amount: '20.00', baseAmount: '400.00', ratePercent: '5.00', period: today.slice(0, 7), vendorId: b.v.vendorId });
      expect(cert?.number).toMatch(/^WHC-\d{4}-\d{5}$/);
      // It cannot be rewritten or deleted.
      expect(await codeOf(db.update(schema.withholdingCertificates).set({ amount: '1.00' }).where(eq(schema.withholdingCertificates.id, required(cert).id)))).toBe('23001');
      expect(await codeOf(db.delete(schema.withholdingCertificates).where(eq(schema.withholdingCertificates.id, required(cert).id)))).toBe('23001');
      // The vendor sees its own, and only its own.
      const mine = await c.paymentTerms.vendorCertificates(b.v.vendorId);
      expect(mine.rows.map((r) => r.number)).toEqual([cert?.number]);
      expect((await c.paymentTerms.certificate(companyId, required(cert).id, b.v.vendorId))?.vendor.name).toMatch(/WT Vendor/);
      const other = await approvedVendor();
      expect(await c.paymentTerms.certificate(companyId, required(cert).id, other.vendorId)).toBeNull();
      expect((await c.paymentTerms.vendorCertificates(other.vendorId)).rows).toHaveLength(0);
      const all = await c.paymentTerms.certificates(companyId, { period: today.slice(0, 7), vendorId: b.v.vendorId });
      expect(all.issuedTotal).toBe('20.00');
      // The remittance shows what was really paid.
      const remit = await c.vendorPayments.remittances(b.v.vendorId);
      expect(remit.rows[0]).toMatchObject({ amount: '444.00' });
      expect(await c.finance.vendorLedger.drift(companyId)).toEqual([]);
      // Reversing brings the invoice back and cancels the certificate.
      await c.vendorPayments.reverse(staff('boss'), id, 'Wrong bank');
      expect(await remaining(b.pinv.ledgerEntryId)).toBe('464.00');
      expect((await db.select().from(schema.withholdingCertificates).where(eq(schema.withholdingCertificates.voucherId, id)))[0]).toMatchObject({ status: 'cancelled' });
      expect(await c.paymentTerms.certificates(companyId, { vendorId: b.v.vendorId })).toMatchObject({ issuedTotal: '0' });
      expect(await c.finance.vendorLedger.drift(companyId)).toEqual([]);
    });

    it('takes a gross-based code on all that is paid, and follows a part payment', async () => {
      const b = await booked();
      await withCode(b.v.vendorId, { percent: '10', base: 'gross' });
      const v = await approvedVoucher(b.v.vendorId, cash, [{ purchaseInvoiceId: b.pinv.id, amount: '232' }]);
      expect(await db.select().from(schema.vendorPaymentVouchers).where(eq(schema.vendorPaymentVouchers.id, v.id)).then((r) => r[0])).toMatchObject({ withholdingAmount: '23.20', cashAmount: '208.80' });
      await c.vendorPayments.pay(staff('till'), v.id, { reference: 'G-1', paidOn: today });
      expect(await remaining(b.pinv.ledgerEntryId)).toBe('232.00');
    });
  });

  describe('early-payment discount', () => {
    it('is taken inside the days, reduces the cash, is booked as discount received, and is put back by a reversal', async () => {
      const b = await booked();
      await c.paymentTerms.saveVendorTerms(staff('admin'), b.v.vendorId, { withholdingCodeId: '', earlyDiscountPercent: '2', earlyDiscountDays: '30' });
      const v = await approvedVoucher(b.v.vendorId, cash, [{ purchaseInvoiceId: b.pinv.id, amount: '464' }]);
      expect(await db.select().from(schema.vendorPaymentVouchers).where(eq(schema.vendorPaymentVouchers.id, v.id)).then((r) => r[0])).toMatchObject({ discountAmount: '9.28', cashAmount: '454.72' });
      await c.vendorPayments.pay(staff('till'), v.id, { reference: 'D-1', paidOn: today });
      const row = required((await db.select().from(schema.vendorPaymentVouchers).where(eq(schema.vendorPaymentVouchers.id, v.id)))[0]);
      expect(await glLines(required(row.registerId))).toEqual([['1110', 0, 454.72], ['2110', 464, 0], ['4420', 0, 9.28]].sort());
      expect(await remaining(b.pinv.ledgerEntryId)).toBe('0.00');
      expect(await remaining(required(row.ledgerEntryId))).toBe('0.00');
      expect(await c.finance.vendorLedger.drift(companyId)).toEqual([]);
      await c.vendorPayments.reverse(staff('boss'), v.id, 'Wrong vendor');
      expect(await remaining(b.pinv.ledgerEntryId)).toBe('464.00');
      expect(await c.finance.vendorLedger.drift(companyId)).toEqual([]);
      const after = required((await db.select().from(schema.vendorPaymentVouchers).where(eq(schema.vendorPaymentVouchers.id, v.id)))[0]);
      const net = await db.execute<{ net: string }>(sql`SELECT COALESCE(SUM(base_debit - base_credit), 0)::text AS net FROM gl_entries WHERE register_id IN (${required(row.registerId)}::uuid, ${required(after.reversalRegisterId)}::uuid)`);
      expect(Number([...net][0]?.net)).toBe(0);
    });

    it('combines with withheld tax and leaves a bank file with the cash, not the invoice', async () => {
      const b = await booked();
      await withCode(b.v.vendorId);
      await c.paymentTerms.saveVendorTerms(staff('admin'), b.v.vendorId, { withholdingCodeId: (await c.paymentTerms.vendorTerms(companyId, b.v.vendorId))?.withholdingCodeId ?? '', earlyDiscountPercent: '2', earlyDiscountDays: '30' });
      const run1 = await c.paymentRuns.create(staff('clerk'), { methodId: transfer, executionDate: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), note: '', selections: [{ vendorId: b.v.vendorId, allocations: [{ purchaseInvoiceId: b.pinv.id, amount: '464' }] }] });
      expect(run1.total).toBe('434.72');
      await c.paymentRuns.submit(staff('clerk'), run1.id);
      const vs = await db.select().from(schema.vendorPaymentVouchers).where(eq(schema.vendorPaymentVouchers.batchId, run1.id));
      await c.paymentRuns.approve(staff('boss'), run1.id, { approveIds: vs.map((x) => x.id), sendBackReason: '' });
      await c.paymentRuns.release(staff('till'), run1.id, { format: 'csv' });
      const file = await c.paymentRuns.download(staff('till'), run1.id);
      expect(file.content).toContain('434.72,KES');
      expect(file.content).not.toContain('464.00');
    });
  });

  describe('tolerance', () => {
    it('closes a small leftover only when asked and within the limit', async () => {
      const b = await booked();
      expect(await codeOf(c.vendorPayments.saveDraft(staff('clerk'), null, voucherHeader(b.v.vendorId, cash), [{ purchaseInvoiceId: b.pinv.id, amount: '400', closeRemainder: true }]))).toBe('TOLERANCE');
      expect(await codeOf(c.vendorPayments.saveDraft(staff('clerk'), null, voucherHeader(b.v.vendorId, cash), [{ purchaseInvoiceId: b.pinv.id, amount: '464', closeRemainder: true }]))).toBe('NOTHING_LEFT');
      // Not asked for: the leftover stays open.
      const plain = await approvedVoucher(b.v.vendorId, cash, [{ purchaseInvoiceId: b.pinv.id, amount: '460' }]);
      await c.vendorPayments.pay(staff('till'), plain.id, { reference: 'T-0', paidOn: today });
      expect(await remaining(b.pinv.ledgerEntryId)).toBe('4.00');
      // Asked for: the 4.00 left is closed with the next payment of 0.50 less than it.
      const { id } = await c.vendorPayments.saveDraft(staff('clerk'), null, voucherHeader(b.v.vendorId, cash), [{ purchaseInvoiceId: b.pinv.id, amount: '3.50', closeRemainder: true }]);
      await c.vendorPayments.submit(staff('clerk'), id);
      await c.vendorPayments.approve(staff('boss'), id);
      await c.vendorPayments.pay(staff('till'), id, { reference: 'T-1', paidOn: today });
      const row = required((await db.select().from(schema.vendorPaymentVouchers).where(eq(schema.vendorPaymentVouchers.id, id)))[0]);
      expect(row).toMatchObject({ toleranceAmount: '0.50', cashAmount: '3.50' });
      expect(await glLines(required(row.registerId))).toEqual([['1110', 0, 3.5], ['2110', 4, 0], ['4420', 0, 0.5]].sort());
      expect(await remaining(b.pinv.ledgerEntryId)).toBe('0.00');
      expect(await c.finance.vendorLedger.drift(companyId)).toEqual([]);
    });
  });
});
