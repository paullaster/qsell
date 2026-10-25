import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import { has, isRecord, readText, required } from '@/lib/values';
import { emptyBusiness, emptyFinancial, emptyProfile, type ProfileData } from '@/lib/vendor-profile';
import { emptyCategory } from '@/lib/prequalification';
import { emptyPoHeader, emptyPoLine, type PoLineForm } from '@/lib/purchase-order';
import type { RgnHeaderForm, RgnLineForm } from '@/lib/rgn';
import { emptyInvoiceHeader, type DeliveryNoteForm, type InvoiceLineForm } from '@/lib/supplier-invoice';
import type { RunSelection } from './payment-run-service';
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

describe.skipIf(!has(url))('payment runs (database)', () => {
  let db: DrizzleDb;
  let schema: typeof mod_schema;
  let c: AppContainer;
  let companyId: string;
  let unit: { code: string; name: string };
  let inputTax = '';
  let transfer = '';
  let cheque = '';
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
    await p.saveContacts(a, [{ name: 'Wanjiru Kamau', role: 'management', email: `prw${String(seq)}.${run}@acme.test`, phone: '0700000000', isPrimary: true }]);
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
    await db.insert(schema.products).values({ id, sku: `PR-${run}-${String(prodSeq)}`.toUpperCase(), stockCode: `PRS-${run}-${String(prodSeq)}`.toUpperCase(), name: `Receiving ${String(prodSeq)}`, slug: `pr-${randomUUID()}`, itemTypeId, price: '999', costPrice: cost, stockQuantity: stock });
    return id;
  }

  /** A sent order with the lines given, for a qualified vendor; returns the order and its line ids. */
  async function sentOrder(v: PortalActor, lines: PoLineForm[], over: { currency?: string; confirm?: boolean; advance?: boolean } = {}) {
    catSeq += 1;
    const cat = await c.categories.save(companyId, null, { ...emptyCategory(), code: `PR${String(catSeq)}_${run}`.toUpperCase(), name: `PR category ${String(catSeq)} ${run}` });
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
      .values({ legalName: 'PR', tradingName: 'PR', email: 'buyer@pr.test', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P' })
      .returning();
    companyId = required(company).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    await c.finance.setup.applyTemplate(staff('reviewer'), 'kenya', { fiscalYearStart: '2026-01-01' });
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    await c.finance.paymentMethods.seedStandard(staff('reviewer'));
    const methods = await db.select().from(schema.paymentMethods).where(eq(schema.paymentMethods.companyId, companyId));
    for (const m of methods) await db.update(schema.paymentMethods).set({ usableFor: ['customer_receipt', 'vendor_payment'] }).where(eq(schema.paymentMethods.id, m.id));
    transfer = required(methods.find((m) => m.kind === 'bank_transfer')).id;
    cheque = required(methods.find((m) => m.kind === 'cheque')).id;
    await db.update(schema.financeSettings).set({ inventoryGlGoLive: '2026-01-01' }).where(eq(schema.financeSettings.companyId, companyId));
    const accounts = await db.select().from(schema.glAccounts).where(eq(schema.glAccounts.companyId, companyId));
    inputTax = required(accounts.find((a) => a.no === '1410')).id;
    await db.insert(schema.vendorSettings).values({ companyId, inputTaxAccountId: inputTax }).onConflictDoUpdate({ target: schema.vendorSettings.companyId, set: { inputTaxAccountId: inputTax } });
    const probe = await product(0, '1');
    const [p] = await db.select({ unitId: schema.products.baseUnitId }).from(schema.products).where(eq(schema.products.id, probe));
    const [u] = await db.select({ code: schema.unitsOfMeasure.code, name: schema.unitsOfMeasure.name }).from(schema.unitsOfMeasure).where(eq(schema.unitsOfMeasure.id, required(p).unitId));
    unit = required(u);
  });



  /** A booked invoice for 4 units at the price given (tax 16%): the amount owed is 4 × price × 1.16. */
  async function booked(price = '100') {
    const s = await setup({ qty: '4', discount: '0' });
    const inv = await approved(s, price);
    await c.invoicePosting.post(staff('finance'), inv.id);
    const [p] = await db.select().from(schema.purchaseInvoices).where(eq(schema.purchaseInvoices.supplierInvoiceId, inv.id));
    return { ...s, inv, pinv: required(p) };
  }

  const remaining = async (entryId: string) => required((await db.select().from(schema.vendorLedgerEntries).where(eq(schema.vendorLedgerEntries.id, entryId)))[0]).remainingAmount;

  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const weekAhead = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const farAhead = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);

  const pick = (b: Awaited<ReturnType<typeof booked>>, amount = '464'): RunSelection => ({ vendorId: b.v.vendorId, allocations: [{ purchaseInvoiceId: b.pinv.id, amount }] });
  const statusOf = async (id: string) => required((await db.select().from(schema.vendorPaymentVouchers).where(eq(schema.vendorPaymentVouchers.id, id)))[0]);
  const batchOf = async (id: string) => required((await db.select().from(schema.vendorPaymentBatches).where(eq(schema.vendorPaymentBatches.id, id)))[0]);

  /** A run, made and sent for approval. */
  async function pending(method: string, picks: RunSelection[]) {
    const run = await c.paymentRuns.create(staff('clerk'), { methodId: method, executionDate: tomorrow, note: '', selections: picks });
    await c.paymentRuns.submit(staff('clerk'), run.id);
    return run;
  }
  async function approvedRun(method: string, picks: RunSelection[]) {
    const run = await pending(method, picks);
    const vouchers = await db.select().from(schema.vendorPaymentVouchers).where(eq(schema.vendorPaymentVouchers.batchId, run.id));
    await c.paymentRuns.approve(staff('boss'), run.id, { approveIds: vouchers.map((v) => v.id), sendBackReason: '' });
    return { ...run, vouchers };
  }

  describe('the proposal', () => {
    it('lists what is due by vendor, leaves out blocked vendors and ones with no bank account, and respects the limits and the holds', async () => {
      const a = await booked();
      const b = await booked();
      const blocked = await booked();
      const noBank = await booked();
      await db.update(schema.vendors).set({ block: 'payment' }).where(eq(schema.vendors.id, blocked.v.vendorId));
      await db.update(schema.vendorBankAccounts).set({ status: 'retired' }).where(eq(schema.vendorBankAccounts.vendorId, noBank.v.vendorId));
      const today = new Date().toISOString().slice(0, 10);
      const out = await c.paymentRuns.suggest(companyId, { methodId: transfer, dueOn: today });
      const ids = out.vendors.map((v) => v.vendorId);
      expect(ids).toEqual(expect.arrayContaining([a.v.vendorId, b.v.vendorId]));
      expect(ids).not.toContain(blocked.v.vendorId);
      expect(ids).not.toContain(noBank.v.vendorId);
      expect(out.excluded.find((e) => e.vendorId === blocked.v.vendorId)?.reason).toMatch(/Blocked/);
      expect(out.excluded.find((e) => e.vendorId === noBank.v.vendorId)?.reason).toMatch(/No bank account/);
      // Cash needs no bank account.
      const cash = await c.paymentRuns.suggest(companyId, { methodId: transfer.length > 0 ? (required((await db.select().from(schema.paymentMethods).where(eq(schema.paymentMethods.companyId, companyId))).find((m) => m.kind === 'cash')).id) : '', dueOn: today });
      expect(cash.vendors.map((v) => v.vendorId)).toContain(noBank.v.vendorId);
      expect(out.vendors.find((v) => v.vendorId === a.v.vendorId)?.totalCents).toBe(46400);
      // Limits.
      const limited = await c.paymentRuns.suggest(companyId, { methodId: transfer, dueOn: today, vendorId: a.v.vendorId, minCents: 50000 });
      expect(limited.vendors).toHaveLength(0);
      expect(limited.excluded[0]?.reason).toMatch(/Below the minimum/);
      // What a live voucher holds is not offered again.
      await c.paymentRuns.create(staff('clerk'), { methodId: transfer, executionDate: tomorrow, note: '', selections: [pick(a)] });
      const again = await c.paymentRuns.suggest(companyId, { methodId: transfer, dueOn: today, vendorId: a.v.vendorId });
      expect(again.vendors).toHaveLength(0);
      // Nothing is due in the past.
      const early = await c.paymentRuns.suggest(companyId, { methodId: transfer, dueOn: '2000-01-01', vendorId: b.v.vendorId });
      expect(early.vendors).toHaveLength(0);
    });
  });

  describe('making and approving a run', () => {
    it('makes one draft voucher per vendor, checks the date and the vendors, and is approved as one by someone else', async () => {
      const a = await booked();
      const b = await booked();
      expect(await codeOf(c.paymentRuns.create(staff('clerk'), { methodId: transfer, executionDate: '2000-01-01', note: '', selections: [pick(a)] }))).toBe('DATE_INVALID');
      expect(await codeOf(c.paymentRuns.create(staff('clerk'), { methodId: transfer, executionDate: farAhead, note: '', selections: [pick(a)] }))).toBe('DATE_INVALID');
      expect(await codeOf(c.paymentRuns.create(staff('clerk'), { methodId: transfer, executionDate: tomorrow, note: '', selections: [] }))).toBe('NOTHING_TO_PAY');
      expect(await codeOf(c.paymentRuns.create(staff('clerk'), { methodId: transfer, executionDate: tomorrow, note: '', selections: [pick(a), pick(a)] }))).toBe('INVALID');
      expect(await codeOf(c.paymentRuns.create(staff('clerk'), { methodId: transfer, executionDate: tomorrow, note: '', selections: [pick(a, '9999')] }))).toBe('INVALID');
      const run = await c.paymentRuns.create(staff('clerk'), { methodId: transfer, executionDate: weekAhead, note: 'Weekly run', selections: [pick(a), pick(b, '100')] });
      expect(run).toMatchObject({ count: 2, total: '564.00' });
      expect(run.number).toMatch(/^VPB-\d{4}-\d{5}$/);
      const vouchers = await db.select().from(schema.vendorPaymentVouchers).where(eq(schema.vendorPaymentVouchers.batchId, run.id));
      expect(vouchers.map((v) => v.status)).toEqual(['draft', 'draft']);
      await c.paymentRuns.submit(staff('clerk'), run.id);
      expect(await codeOf(c.paymentRuns.submit(staff('clerk'), run.id))).toBe('WRONG_STATE');
      expect(await codeOf(c.paymentRuns.approve(staff('clerk'), run.id, { approveIds: vouchers.map((v) => v.id), sendBackReason: '' }))).toBe('FOUR_EYES');
      // Leave one out: it needs a reason and goes back to its writer, out of the run.
      expect(await codeOf(c.paymentRuns.approve(staff('boss'), run.id, { approveIds: [required(vouchers[0]).id], sendBackReason: ' ' }))).toBe('NOTE_REQUIRED');
      expect(await c.paymentRuns.approve(staff('boss'), run.id, { approveIds: [required(vouchers[0]).id], sendBackReason: 'Check the second invoice' })).toEqual({ approved: 1, sentBack: 1 });
      const after = await batchOf(run.id);
      expect(after).toMatchObject({ status: 'approved', itemCount: 1 });
      const left = await statusOf(required(vouchers[1]).id);
      expect(left).toMatchObject({ status: 'draft', batchId: null, sendBackReason: 'Check the second invoice' });
      // Nothing approved ends the run.
      const c2 = await booked();
      const second = await pending(transfer, [pick(c2)]);
      const only = await db.select().from(schema.vendorPaymentVouchers).where(eq(schema.vendorPaymentVouchers.batchId, second.id));
      expect(await c.paymentRuns.approve(staff('boss'), second.id, { approveIds: [], sendBackReason: 'Not this week' })).toEqual({ approved: 0, sentBack: 1 });
      expect((await batchOf(second.id)).status).toBe('cancelled');
      expect((await statusOf(required(only[0]).id)).batchId).toBeNull();
    });
  });

  describe('releasing', () => {
    it('makes a bank file with the account numbers, keeps only its fingerprint, and rebuilds it for download', async () => {
      const a = await booked();
      const run = await approvedRun(transfer, [pick(a)]);
      expect(await codeOf(c.paymentRuns.release(staff('till'), run.id, {}))).toBe('FORMAT_INVALID');
      expect(await codeOf(c.paymentRuns.download(staff('till'), run.id))).toBe('NO_FILE');
      await c.paymentRuns.release(staff('till'), run.id, { format: 'csv' });
      const row = await batchOf(run.id);
      expect(row).toMatchObject({ status: 'released', format: 'csv', releasedBy: 'till' });
      expect(row.contentSha256).toMatch(/^[0-9a-f]{64}$/);
      const file = await c.paymentRuns.download(staff('till'), run.id);
      expect(file.fileName).toBe(`${run.number}.csv`);
      expect(file.content.split('\r\n')[0]).toBe('Reference,Beneficiary name,Bank,Account number,Amount,Currency,Narrative');
      expect(file.content).toContain('464.00,KES');
      expect(file.content).toMatch(/,\d{10},464\.00,KES/);
      expect(file.sha256).toBe(row.contentSha256);
      expect((await batchOf(run.id)).downloads).toBe(1);
      // The bank account itself cannot be edited (a database rule), but a changed amount after release breaks the fingerprint.
      expect(await codeOf(db.update(schema.vendorBankAccounts).set({ accountName: 'Someone Else Ltd' }).where(eq(schema.vendorBankAccounts.vendorId, a.v.vendorId)))).toBe('23001');
      await db.update(schema.vendorPaymentVouchers).set({ amount: '1.00', cashAmount: '1.00' }).where(eq(schema.vendorPaymentVouchers.batchId, run.id));
      expect(await codeOf(c.paymentRuns.download(staff('till'), run.id))).toBe('FILE_ALTERED');
      // The file itself is not in the database.
      const stored = await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM vendor_payment_batches WHERE id = ${run.id}::uuid AND to_jsonb(vendor_payment_batches)::text LIKE '%Account number%'`);
      expect(Number([...stored][0]?.n)).toBe(0);
    });

    it('needs the debtor account for an ISO 20022 file, and a third person when the vouchers need three', async () => {
      const a = await booked();
      const run = await approvedRun(transfer, [pick(a)]);
      expect(await codeOf(c.paymentRuns.release(staff('till'), run.id, { format: 'pain001' }))).toBe('BANK_ACCOUNT_NUMBER_MISSING');
      const methods = await db.select().from(schema.paymentMethods).where(eq(schema.paymentMethods.id, transfer));
      await db.update(schema.bankAccounts).set({ details: { accountNumber: '0123456789' } }).where(eq(schema.bankAccounts.id, required(methods[0]).balancingBankAccountId));
      await c.paymentRuns.release(staff('till'), run.id, { format: 'pain001' });
      const file = await c.paymentRuns.download(staff('till'), run.id);
      expect(file.content).toContain('pain.001.001.03');
      expect(file.content).toContain(`<MsgId>${run.number}</MsgId>`);
      expect(file.content).toContain('<CtrlSum>464.00</CtrlSum>');
      // Three people: the preparer cannot release a run of vouchers above the value.
      await c.purchaseOrders.saveSettings(staff('admin'), { rfqRequiredAbove: '', amendmentTolerancePercent: '0', paymentThreeEyesAbove: '400' });
      const b = await booked();
      const big = await approvedRun(transfer, [pick(b)]);
      expect(await codeOf(c.paymentRuns.release(staff('clerk'), big.id, { format: 'csv' }))).toBe('THREE_PEOPLE');
      expect(await codeOf(c.paymentRuns.release(staff('boss'), big.id, { format: 'csv' }))).toBe('THREE_PEOPLE');
      expect(await codeOf(c.paymentRuns.release(staff('till'), big.id, { format: 'csv' }))).toBe('OK');
      await c.purchaseOrders.saveSettings(staff('admin'), { rfqRequiredAbove: '', amendmentTolerancePercent: '0', paymentThreeEyesAbove: '100000' });
    });

    it('writes a cheque run: numbers in a row, a list for the cheque writer, and a number cannot be used twice', async () => {
      const a = await booked();
      const b = await booked();
      const run = await approvedRun(cheque, [pick(a), pick(b)]);
      expect(await codeOf(c.paymentRuns.release(staff('till'), run.id, { firstChequeNo: 'abc' }))).toBe('CHEQUE_NUMBER');
      await c.paymentRuns.release(staff('till'), run.id, { firstChequeNo: '004500' });
      const vouchers = (await db.select().from(schema.vendorPaymentVouchers).where(eq(schema.vendorPaymentVouchers.batchId, run.id))).sort((x, y) => (x.chequeNo ?? '').localeCompare(y.chequeNo ?? ''));
      expect(vouchers.map((v) => v.chequeNo)).toEqual(['004500', '004501']);
      const list = await c.paymentRuns.download(staff('till'), run.id);
      expect(list.fileName).toBe(`${run.number}-cheques.csv`);
      expect(list.content).toContain('004500');
      expect(list.content).toContain('464.00,KES');
      // The same numbers on the same cheque book cannot be given again while those vouchers are alive.
      const c3 = await booked();
      const other = await approvedRun(cheque, [pick(c3)]);
      expect(await codeOf(c.paymentRuns.release(staff('till'), other.id, { firstChequeNo: '004501' }))).toBe('CHEQUE_NUMBER_USED');
      expect((await batchOf(other.id)).status).toBe('approved');
    });
  });

  describe('confirming', () => {
    it('pays every voucher together on the confirmation of someone who did not release it, and all or none', async () => {
      const a = await booked();
      const b = await booked();
      const run = await approvedRun(transfer, [pick(a), pick(b)]);
      await c.paymentRuns.release(staff('till'), run.id, { format: 'csv' });
      expect(await codeOf(c.paymentRuns.confirm(staff('till'), run.id, { reference: 'BANK-1', paidOn: new Date().toISOString().slice(0, 10) }))).toBe('SAME_PERSON');
      expect(await codeOf(db.update(schema.vendorPaymentBatches).set({ status: 'confirmed', confirmedBy: 'till' }).where(eq(schema.vendorPaymentBatches.id, run.id)))).toBe('23514');
      expect(await codeOf(c.paymentRuns.confirm(staff('cashier'), run.id, { reference: ' ', paidOn: new Date().toISOString().slice(0, 10) }))).toBe('REFERENCE_REQUIRED');
      // One vendor was blocked meanwhile: nobody in the run is paid.
      await db.update(schema.vendors).set({ block: 'all' }).where(eq(schema.vendors.id, b.v.vendorId));
      expect(await codeOf(c.paymentRuns.confirm(staff('cashier'), run.id, { reference: 'BANK-1', paidOn: new Date().toISOString().slice(0, 10) }))).toBe('VENDOR_BLOCKED');
      expect(await remaining(a.pinv.ledgerEntryId)).toBe('464.00');
      expect((await batchOf(run.id)).status).toBe('released');
      await db.update(schema.vendors).set({ block: 'none' }).where(eq(schema.vendors.id, b.v.vendorId));
      expect(await c.paymentRuns.confirm(staff('cashier'), run.id, { reference: 'BANK-1', paidOn: new Date().toISOString().slice(0, 10) })).toEqual({ paid: 2 });
      expect(await remaining(a.pinv.ledgerEntryId)).toBe('0.00');
      expect(await remaining(b.pinv.ledgerEntryId)).toBe('0.00');
      const paid = await db.select().from(schema.vendorPaymentVouchers).where(eq(schema.vendorPaymentVouchers.batchId, run.id));
      expect(paid.map((v) => v.status)).toEqual(['paid', 'paid']);
      expect(paid.every((v) => v.paymentReference?.startsWith('BANK-1 / VPV-') === true)).toBe(true);
      expect(await batchOf(run.id)).toMatchObject({ status: 'confirmed', confirmedBy: 'cashier', bankReference: 'BANK-1' });
      expect(await codeOf(c.paymentRuns.confirm(staff('cashier'), run.id, { reference: 'BANK-2', paidOn: new Date().toISOString().slice(0, 10) }))).toBe('WRONG_STATE');
      expect(await codeOf(c.paymentRuns.cancel(staff('boss'), run.id, 'late'))).toBe('WRONG_STATE');
      expect(await codeOf(db.delete(schema.vendorPaymentBatches).where(eq(schema.vendorPaymentBatches.id, run.id)))).toBe('23001');
      expect(await c.finance.vendorLedger.drift(companyId)).toEqual([]);
    });
  });

  describe('cancelling', () => {
    it('drops the vouchers of an unapproved run, and frees approved ones to be paid on their own', async () => {
      const a = await booked();
      const waiting = await pending(transfer, [pick(a)]);
      const mine = await db.select().from(schema.vendorPaymentVouchers).where(eq(schema.vendorPaymentVouchers.batchId, waiting.id));
      expect(await codeOf(c.paymentRuns.cancel(staff('clerk'), waiting.id, ' '))).toBe('NOTE_REQUIRED');
      await c.paymentRuns.cancel(staff('clerk'), waiting.id, 'Wrong week');
      expect((await batchOf(waiting.id)).status).toBe('cancelled');
      expect((await statusOf(required(mine[0]).id)).status).toBe('cancelled');
      expect((await c.vendorPayments.openItems(companyId, a.v.vendorId))[0]?.available).toBe('464.00');
      // An approved run: its vouchers stay approved and can be paid one by one.
      const b = await booked();
      const run = await approvedRun(transfer, [pick(b)]);
      await c.paymentRuns.cancel(staff('boss'), run.id, 'Bank closed today');
      const free = await statusOf(required(run.vouchers[0]).id);
      expect(free).toMatchObject({ status: 'approved', batchId: null });
      expect(await codeOf(c.vendorPayments.pay(staff('till'), free.id, { reference: 'TRX-9', paidOn: new Date().toISOString().slice(0, 10) }))).toBe('OK');
    });
  });
});
