import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { has, isRecord, readText, required } from '@/lib/values';
import { emptyBusiness, emptyFinancial, emptyProfile, type ProfileData } from '@/lib/vendor-profile';
import { emptyCategory } from '@/lib/prequalification';
import { emptyPoHeader, emptyPoLine, type PoLineForm } from '@/lib/purchase-order';
import type { RgnHeaderForm, RgnLineForm } from '@/lib/rgn';
import { emptyInvoiceHeader, type DeliveryNoteForm, type InvoiceLineForm } from '@/lib/supplier-invoice';
import type { AllocationForm, VoucherHeaderForm } from '@/lib/vendor-payment';
import type { CreditHeaderForm, CreditLineForm } from '@/lib/vendor-credit-memo';
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

describe.skipIf(!has(url))('credit memos from vendors (database)', () => {
  let db: DrizzleDb;
  let schema: typeof mod_schema;
  let c: AppContainer;
  let companyId: string;
  let unit: { code: string; name: string };
  let inputTax = '';
  let cash = '';
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
    const [u] = await db.insert(schema.users).values({ email: `cm${String(seq)}.${run}@example.test`, passwordHash: 'x', name: 'Owner', role: 'vendor' }).returning();
    const vendorId = await c.vendors.registerBusiness({ companyId, userId: required(u).id, legalName: `CM Vendor ${run} ${String(seq)}`, email: `cm${String(seq)}.${run}@example.test`, phone: null });
    const a: PortalActor = { vendorId, userId: required(u).id, portalRole: 'owner' };
    const p = c.vendorProfile;
    const profile: ProfileData = { ...emptyProfile(), country: 'Kenya', description: 'We supply solar panels and inverters to businesses.', physicalStreet: '1 Mombasa Road', physicalCity: 'Nairobi', phone: '+254 700 000 000' };
    await p.saveProfile(a, profile);
    await p.saveBusiness(a, { ...emptyBusiness(), registrationNo: 'CPR/2012/12345', registrationDate: '2012-03-04', taxId: `G${String(Date.now()).slice(-9)}${String(seq % 10)}` });
    await p.addDirector(a, { name: 'Wanjiru Kamau', idType: 'national_id', idNumber: '12345678', sharePercent: '100' });
    await p.addBank(a, { bankName: 'KCB', branch: 'Moi Avenue', accountName: 'Acme Ltd', accountNumber: `0123${String(seq).padStart(6, '0')}`, swift: '' });
    await p.saveFinancial(a, { ...emptyFinancial(), offeredPaymentTermDays: '30' });
    await p.saveContacts(a, [{ name: 'Wanjiru Kamau', role: 'management', email: `cmw${String(seq)}.${run}@acme.test`, phone: '0700000000', isPrimary: true }]);
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
    await db.insert(schema.products).values({ id, sku: `CM-${run}-${String(prodSeq)}`.toUpperCase(), stockCode: `CMS-${run}-${String(prodSeq)}`.toUpperCase(), name: `Receiving ${String(prodSeq)}`, slug: `cm-${randomUUID()}`, itemTypeId, price: '999', costPrice: cost, stockQuantity: stock });
    return id;
  }

  /** A sent order with the lines given, for a qualified vendor; returns the order and its line ids. */
  async function sentOrder(v: PortalActor, lines: PoLineForm[], over: { currency?: string; confirm?: boolean; advance?: boolean } = {}) {
    catSeq += 1;
    const cat = await c.categories.save(companyId, null, { ...emptyCategory(), code: `CM${String(catSeq)}_${run}`.toUpperCase(), name: `CM category ${String(catSeq)} ${run}` });
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
      .values({ legalName: 'CM', tradingName: 'CM', email: 'buyer@cm.test', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P' })
      .returning();
    companyId = required(company).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    await c.finance.setup.applyTemplate(staff('reviewer'), 'kenya', { fiscalYearStart: '2026-01-01' });
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    await c.finance.paymentMethods.seedStandard(staff('reviewer'));
    const methods = await db.select().from(schema.paymentMethods).where(eq(schema.paymentMethods.companyId, companyId));
    for (const m of methods) await db.update(schema.paymentMethods).set({ usableFor: ['customer_receipt', 'vendor_payment'] }).where(eq(schema.paymentMethods.id, m.id));
    cash = required(methods.find((m) => m.kind === 'cash')).id;
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


  const today = new Date().toISOString().slice(0, 10);
  const memoHeader = (no: string, reason = 'Billed more than delivered'): CreditHeaderForm => ({ vendorCreditNo: no, creditDate: today, reason, notes: '' });
  const glLines = async (registerId: string) => {
    const accounts = await db.select().from(schema.glAccounts).where(eq(schema.glAccounts.companyId, companyId));
    const rows = await db.select().from(schema.glEntries).where(eq(schema.glEntries.registerId, registerId));
    return rows.map((e) => [accounts.find((a) => a.id === e.accountId)?.no, Number(e.debit), Number(e.credit)]).sort();
  };
  const memoRow = async (id: string) => required((await db.select().from(schema.vendorCreditMemos).where(eq(schema.vendorCreditMemos.id, id)))[0]);

  /** A booked invoice for 4 units at 100 plus tax, and a draft credit memo against it. */
  async function started(no = `CN-${run}-${String(++seq)}`) {
    const b = await booked();
    const { id } = await c.creditMemoPortal.start(b.v, companyId, { purchaseInvoiceId: b.pinv.id, vendorCreditNo: no });
    const loaded = await c.creditMemoPortal.load(b.v, id);
    const file = await c.creditMemoPortal.addFile(b.v, companyId, { originalName: 'credit.pdf', data: PDF });
    return { ...b, id, no, line: required(loaded.originals[0]).id, file: file.id };
  }
  async function sendMemo(s: Awaited<ReturnType<typeof started>>, lines: CreditLineForm[]) {
    await c.creditMemoPortal.save(s.v, s.id, { header: memoHeader(s.no), lines, fileId: s.file });
    return await c.creditMemoPortal.submit(s.v, companyId, s.id);
  }
  async function approvedMemo(s: Awaited<ReturnType<typeof started>>, lines: CreditLineForm[]) {
    await sendMemo(s, lines);
    await c.creditMemos.pickUp(staff('clerk'), s.id);
    await c.creditMemos.approve(staff('boss'), s.id);
  }

  describe('the vendor makes a credit note', () => {
    it('is for one of its own booked invoices, with a number of its own', async () => {
      const b = await booked();
      const other = await approvedVendor();
      expect(await codeOf(c.creditMemoPortal.start(other, companyId, { purchaseInvoiceId: b.pinv.id, vendorCreditNo: 'X-1' }))).toBe('NOT_FOUND');
      expect(await codeOf(c.creditMemoPortal.start({ ...b.v, portalRole: 'sales' }, companyId, { purchaseInvoiceId: b.pinv.id, vendorCreditNo: 'X-1' }))).toBe('NOT_ALLOWED');
      expect(await codeOf(c.creditMemoPortal.start(b.v, companyId, { purchaseInvoiceId: b.pinv.id, vendorCreditNo: ' ' }))).toBe('INVALID');
      const no = `CN-${run}-dup`;
      await c.creditMemoPortal.start(b.v, companyId, { purchaseInvoiceId: b.pinv.id, vendorCreditNo: no });
      expect(await codeOf(c.creditMemoPortal.start(b.v, companyId, { purchaseInvoiceId: b.pinv.id, vendorCreditNo: ` ${no.toUpperCase()} ` }))).toBe('DUPLICATE');
      expect((await c.creditMemoPortal.invoices(b.v.vendorId)).map((i) => i.id)).toContain(b.pinv.id);
      expect((await c.creditMemoPortal.invoices(other.vendorId))).toHaveLength(0);
    });

    it('works out the totals itself, refuses more than was billed, and needs a reason and its own credit note to be sent', async () => {
      const s = await started();
      const saved = await c.creditMemoPortal.save(s.v, s.id, { header: memoHeader(s.no), lines: [{ invoiceLineId: s.line, mode: 'quantity', quantity: '1', unitPrice: '' }], fileId: s.file });
      expect(saved).toEqual({ subtotal: '100.00', taxTotal: '16.00', total: '116.00' });
      const price = await c.creditMemoPortal.save(s.v, s.id, { header: memoHeader(s.no), lines: [{ invoiceLineId: s.line, mode: 'price', quantity: '', unitPrice: '10' }], fileId: s.file });
      expect(price).toEqual({ subtotal: '40.00', taxTotal: '6.40', total: '46.40' });
      const over = await c.creditMemoPortal.save(s.v, s.id, { header: memoHeader(s.no), lines: [{ invoiceLineId: s.line, mode: 'quantity', quantity: '5', unitPrice: '' }], fileId: s.file }).catch((e: unknown) => e as { code: string; problems: Record<string, string> });
      expect((over as { problems: Record<string, string> }).problems['line.0.quantity']).toMatch(/Only 4 of this line/);
      const dear = await c.creditMemoPortal.save(s.v, s.id, { header: memoHeader(s.no), lines: [{ invoiceLineId: s.line, mode: 'price', quantity: '', unitPrice: '100.01' }], fileId: s.file }).catch((e: unknown) => e as { problems: Record<string, string> });
      expect((dear as { problems: Record<string, string> }).problems['line.0.unitPrice']).toMatch(/more than the price billed/);
      // Someone else's file cannot be attached.
      const stranger = await approvedVendor();
      const theirs = await c.creditMemoPortal.addFile(stranger, companyId, { originalName: 'x.pdf', data: PDF });
      expect(await codeOf(c.creditMemoPortal.save(s.v, s.id, { header: memoHeader(s.no), lines: [{ invoiceLineId: s.line, mode: 'quantity', quantity: '1', unitPrice: '' }], fileId: theirs.id }))).toBe('FILE');
      // Sending.
      await c.creditMemoPortal.save(s.v, s.id, { header: memoHeader(s.no), lines: [], fileId: '' });
      const bad = await c.creditMemoPortal.submit(s.v, companyId, s.id).catch((e: unknown) => e as { problems: Record<string, string> });
      expect(Object.keys((bad as { problems: Record<string, string> }).problems)).toEqual(expect.arrayContaining(['file', 'lines']));
      await c.creditMemoPortal.save(s.v, s.id, { header: memoHeader(s.no), lines: [{ invoiceLineId: s.line, mode: 'quantity', quantity: '1', unitPrice: '' }], fileId: s.file });
      const sent = await c.creditMemoPortal.submit(s.v, companyId, s.id);
      expect(sent.number).toMatch(/^VCM-\d{4}-\d{5}$/);
      expect(await codeOf(c.creditMemoPortal.submit(s.v, companyId, s.id))).toBe('LOCKED');
      expect(await codeOf(c.creditMemoPortal.close(s.v, s.id, 'x'))).toBe('LOCKED');
    });

    it('takes a quantity once across credit notes: two cannot credit the same goods, and a taken-back one frees them', async () => {
      const s = await started();
      await sendMemo(s, [{ invoiceLineId: s.line, mode: 'quantity', quantity: '3', unitPrice: '' }]);
      const second = await c.creditMemoPortal.start(s.v, companyId, { purchaseInvoiceId: s.pinv.id, vendorCreditNo: `CN-${run}-${String(++seq)}` });
      const file = await c.creditMemoPortal.addFile(s.v, companyId, { originalName: 'c2.pdf', data: PDF });
      const tooMany = await c.creditMemoPortal.save(s.v, second.id, { header: memoHeader(`CN-${run}-b`), lines: [{ invoiceLineId: s.line, mode: 'quantity', quantity: '2', unitPrice: '' }], fileId: file.id }).catch((e: unknown) => e as { problems: Record<string, string> });
      expect((tooMany as { problems: Record<string, string> }).problems['line.0.quantity']).toMatch(/Only 1 of this line/);
      await c.creditMemoPortal.recall(s.v, s.id);
      expect(await codeOf(c.creditMemoPortal.save(s.v, second.id, { header: memoHeader(`CN-${run}-b`), lines: [{ invoiceLineId: s.line, mode: 'quantity', quantity: '2', unitPrice: '' }], fileId: file.id }))).toBe('OK');
    });
  });

  describe('taking it back', () => {
    it('only while nobody has touched it, whichever acts first; a returned credit note is corrected and sent again as the next version', async () => {
      const s = await started();
      await sendMemo(s, [{ invoiceLineId: s.line, mode: 'quantity', quantity: '1', unitPrice: '' }]);
      await c.creditMemoPortal.recall(s.v, s.id);
      expect(await codeOf(c.creditMemos.pickUp(staff('clerk'), s.id))).toBe('NOT_FOUND');
      const again = await c.creditMemoPortal.submit(s.v, companyId, s.id);
      await c.creditMemos.pickUp(staff('clerk'), s.id);
      expect(await codeOf(c.creditMemoPortal.recall(s.v, s.id))).toBe('TOO_LATE');
      expect(await codeOf(c.creditMemos.pickUp(staff('other'), s.id))).toBe('WRONG_STATE');
      expect(await codeOf(c.creditMemos.returnToVendor(staff('clerk'), s.id, 'wrong_quantity', ' '))).toBe('NOTE_REQUIRED');
      await c.creditMemos.returnToVendor(staff('clerk'), s.id, 'wrong_quantity', 'Credit 2 not 1');
      const back = await c.creditMemoPortal.load(s.v, s.id);
      expect(back).toMatchObject({ state: 'returned', editable: true, number: again.number, returnReason: { note: 'Credit 2 not 1' } });
      await c.creditMemoPortal.save(s.v, s.id, { header: memoHeader(s.no), lines: [{ invoiceLineId: s.line, mode: 'quantity', quantity: '2', unitPrice: '' }], fileId: s.file });
      await c.creditMemoPortal.submit(s.v, companyId, s.id);
      expect((await c.creditMemoPortal.load(s.v, s.id)).revision).toBe(2);
      await c.creditMemos.pickUp(staff('clerk'), s.id);
      await c.creditMemos.reject(staff('clerk'), s.id, 'duplicate', '');
      expect((await c.creditMemoPortal.load(s.v, s.id)).rejectReason?.label).toMatch(/already have/);
    });
  });

  describe('booking', () => {
    it('is approved by another person, reduces what is owed, credits the lines back in the books, and makes the goods uninvoiced again', async () => {
      const s = await started();
      await sendMemo(s, [{ invoiceLineId: s.line, mode: 'quantity', quantity: '1', unitPrice: '' }]);
      await c.creditMemos.pickUp(staff('clerk'), s.id);
      expect(await codeOf(c.creditMemos.approve(staff('clerk'), s.id))).toBe('FOUR_EYES');
      expect(await codeOf(db.update(schema.vendorCreditMemos).set({ state: 'approved', approvedBy: 'clerk' }).where(eq(schema.vendorCreditMemos.id, s.id)))).toBe('23514');
      expect(await codeOf(c.creditMemos.post(staff('finance'), s.id))).toBe('WRONG_STATE');
      await c.creditMemos.approve(staff('boss'), s.id);
      const out = await c.creditMemos.post(staff('finance'), s.id);
      expect(out.number).toMatch(/^VCM-/);
      const row = await memoRow(s.id);
      expect(row.state).toBe('posted');
      expect(await glLines(required(row.registerId))).toEqual([['1410', 0, 16], ['2110', 116, 0], ['2130', 0, 100]].sort());
      // The invoice's open amount is reduced; the credit entry is used up.
      expect(await remaining(s.pinv.ledgerEntryId)).toBe('348.00');
      expect(await remaining(required(row.ledgerEntryId))).toBe('0.00');
      // The goods are uninvoiced again, so a corrected invoice can follow.
      const [goods] = await db.select().from(schema.rgnLines).where(eq(schema.rgnLines.poLineId, s.line === '' ? '' : required((await db.select().from(schema.supplierInvoiceLines).where(eq(schema.supplierInvoiceLines.id, s.line)))[0]).poLineId));
      expect(goods?.invoicedQuantity).toBe('3.000');
      const room = await c.invoicePortal.orders(s.v.vendorId);
      expect(room.length).toBeGreaterThan(0);
      expect(required(await c.purchaseOrders.get(companyId, s.order.id)).po.status).toBe('partially_invoiced');
      expect(await codeOf(c.creditMemos.post(staff('finance'), s.id))).toBe('ALREADY_POSTED');
      expect(await codeOf(db.update(schema.vendorCreditMemos).set({ reason: 'tamper' }).where(eq(schema.vendorCreditMemos.id, s.id)))).toBe('23001');
      expect(await codeOf(c.creditMemos.returnToVendor(staff('clerk'), s.id, 'other', 'late'))).toBe('WRONG_STATE');
      expect((await c.payablesReports.reconcile(companyId)).ok).toBe(true);
      expect(await c.finance.vendorLedger.drift(companyId)).toEqual([]);
    });

    it('credits a price difference without touching the goods', async () => {
      const s = await started();
      await approvedMemo(s, [{ invoiceLineId: s.line, mode: 'price', quantity: '', unitPrice: '10' }]);
      await c.creditMemos.post(staff('finance'), s.id);
      const row = await memoRow(s.id);
      expect(await glLines(required(row.registerId))).toEqual([['1410', 0, 6.4], ['2110', 46.4, 0], ['2130', 0, 40]].sort());
      expect(await remaining(s.pinv.ledgerEntryId)).toBe('417.60');
      const poLine = required((await db.select().from(schema.supplierInvoiceLines).where(eq(schema.supplierInvoiceLines.id, s.line)))[0]).poLineId;
      expect((await db.select().from(schema.rgnLines).where(eq(schema.rgnLines.poLineId, poLine)))[0]?.invoicedQuantity).toBe('4.000');
      expect(required(await c.purchaseOrders.get(companyId, s.order.id)).po.status).toBe('invoiced');
    });

    it('stays as a credit with the vendor when the invoice was already paid, and is set against a later invoice', async () => {
      const s = await started();
      const v = await approvedVoucher(s.v.vendorId, cash, [{ purchaseInvoiceId: s.pinv.id, amount: '464' }]);
      await c.vendorPayments.pay(staff('till'), v.id, { reference: 'CM-PAID', paidOn: today });
      expect(await remaining(s.pinv.ledgerEntryId)).toBe('0.00');
      await approvedMemo(s, [{ invoiceLineId: s.line, mode: 'quantity', quantity: '1', unitPrice: '' }]);
      await c.creditMemos.post(staff('finance'), s.id);
      const row = await memoRow(s.id);
      expect(await remaining(required(row.ledgerEntryId))).toBe('-116.00');
      expect((await c.vendorPayments.openCredits(companyId, s.v.vendorId)).map((x) => [x.kind, x.openCents])).toEqual([['credit_memo', 11600]]);
      expect((await c.payablesReports.ageing(companyId, today)).lines.find((l) => l.vendorId === s.v.vendorId)?.unappliedCents).toBe(-11600);
      // A later invoice of the same vendor uses it.
      const order2 = await sentOrder(s.v, [stockLine(s.prod, { quantity: '2', discountPercent: '0', unitPrice: '100' })], { confirm: true });
      const note = dn();
      await receive(order2.id, [rl(required(order2.lines[0]), '2')], note);
      const inv2 = await approved({ v: s.v, prod: s.prod, order: order2, line: required(order2.lines[0]), note });
      await c.invoicePosting.post(staff('finance'), inv2.id);
      const [p2] = await db.select().from(schema.purchaseInvoices).where(eq(schema.purchaseInvoices.supplierInvoiceId, inv2.id));
      expect(await c.vendorPayments.applyCredit(staff('finance'), required(p2).id)).toEqual({ appliedCents: 11600 });
      expect(await remaining(required(p2).ledgerEntryId)).toBe('116.00');
      expect(await remaining(required(row.ledgerEntryId))).toBe('0.00');
      expect((await c.payablesReports.reconcile(companyId)).ok).toBe(true);
    });
  });
});
