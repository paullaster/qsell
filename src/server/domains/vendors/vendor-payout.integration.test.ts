import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { has, isRecord, readText, required } from '@/lib/values';
import { emptyBusiness, emptyFinancial, emptyProfile, type ProfileData } from '@/lib/vendor-profile';
import { emptyCategory } from '@/lib/prequalification';
import { emptyPoHeader, emptyPoLine, type PoLineForm } from '@/lib/purchase-order';
import type { RgnHeaderForm, RgnLineForm } from '@/lib/rgn';
import { emptyInvoiceHeader, type DeliveryNoteForm, type InvoiceLineForm } from '@/lib/supplier-invoice';
import { encryptCredentials, fingerprintSecret } from '@/server/domains/payments/crypto';
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

describe.skipIf(!has(url))('vendor payouts through M-Pesa (database)', () => {
  let db: DrizzleDb;
  let schema: typeof mod_schema;
  let c: AppContainer;
  let companyId: string;
  let unit: { code: string; name: string };
  let inputTax = '';
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
    const [u] = await db.insert(schema.users).values({ email: `mp${String(seq)}.${run}@example.test`, passwordHash: 'x', name: 'Owner', role: 'vendor' }).returning();
    const vendorId = await c.vendors.registerBusiness({ companyId, userId: required(u).id, legalName: `MP Vendor ${run} ${String(seq)}`, email: `mp${String(seq)}.${run}@example.test`, phone: null });
    const a: PortalActor = { vendorId, userId: required(u).id, portalRole: 'owner' };
    const p = c.vendorProfile;
    const profile: ProfileData = { ...emptyProfile(), country: 'Kenya', description: 'We supply solar panels and inverters to businesses.', physicalStreet: '1 Mombasa Road', physicalCity: 'Nairobi', phone: '+254 700 000 000' };
    await p.saveProfile(a, profile);
    await p.saveBusiness(a, { ...emptyBusiness(), registrationNo: 'CPR/2012/12345', registrationDate: '2012-03-04', taxId: `G${String(Date.now()).slice(-9)}${String(seq % 10)}` });
    await p.addDirector(a, { name: 'Wanjiru Kamau', idType: 'national_id', idNumber: '12345678', sharePercent: '100' });
    await p.addBank(a, { bankName: 'KCB', branch: 'Moi Avenue', accountName: 'Acme Ltd', accountNumber: `0123${String(seq).padStart(6, '0')}`, swift: '' });
    await p.saveFinancial(a, { ...emptyFinancial(), offeredPaymentTermDays: '30' });
    await p.saveContacts(a, [{ name: 'Wanjiru Kamau', role: 'management', email: `mpw${String(seq)}.${run}@acme.test`, phone: '0700000000', isPrimary: true }]);
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
    await db.insert(schema.products).values({ id, sku: `MP-${run}-${String(prodSeq)}`.toUpperCase(), stockCode: `MPS-${run}-${String(prodSeq)}`.toUpperCase(), name: `Receiving ${String(prodSeq)}`, slug: `mp-${randomUUID()}`, itemTypeId, price: '999', costPrice: cost, stockQuantity: stock });
    return id;
  }

  /** A sent order with the lines given, for a qualified vendor; returns the order and its line ids. */
  async function sentOrder(v: PortalActor, lines: PoLineForm[], over: { currency?: string; confirm?: boolean; advance?: boolean } = {}) {
    catSeq += 1;
    const cat = await c.categories.save(companyId, null, { ...emptyCategory(), code: `MP${String(catSeq)}_${run}`.toUpperCase(), name: `MP category ${String(catSeq)} ${run}` });
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
      .values({ legalName: 'MPT', tradingName: 'MPT', email: 'buyer@mp.test', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P' })
      .returning();
    companyId = required(company).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    await c.finance.setup.applyTemplate(staff('reviewer'), 'kenya', { fiscalYearStart: '2026-01-01' });
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    await c.finance.paymentMethods.seedStandard(staff('reviewer'));
    const methods = await db.select().from(schema.paymentMethods).where(eq(schema.paymentMethods.companyId, companyId));
    for (const m of methods) await db.update(schema.paymentMethods).set({ usableFor: ['customer_receipt', 'vendor_payment'] }).where(eq(schema.paymentMethods.id, m.id));
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



  /** A booked invoice for 4 units at 100 (tax 16%): 464 is owed. */
  async function booked() {
    const s = await setup({ qty: '4', discount: '0' });
    const inv = await approved(s, '100');
    await c.invoicePosting.post(staff('finance'), inv.id);
    const [p] = await db.select().from(schema.purchaseInvoices).where(eq(schema.purchaseInvoices.supplierInvoiceId, inv.id));
    return { ...s, inv, pinv: required(p) };
  }
  const entryRemaining = async (entryId: string) => required((await db.select().from(schema.vendorLedgerEntries).where(eq(schema.vendorLedgerEntries.id, entryId)))[0]).remainingAmount;

  let mpesaMethod = '';
  const op = (voucherId: string, over: Partial<{ status: string; platformReference: string | null }> = {}) => ({ id: randomUUID(), companyId, subjectId: voucherId, status: 'succeeded', platformReference: `QK${String(++seq)}RECEIPT`, failureCode: null, failureReason: null, ...over });
  const destination = async (vendorId: string, kind: 'mpesa_phone' | 'mpesa_paybill' | 'mpesa_till', number: string, reference: string | null = null) => {
    await db.insert(schema.vendorBankAccounts).values({ vendorId, kind, reference, bankName: 'M-Pesa', branch: kind, accountName: 'Registered Name', accountSealed: encryptCredentials({ number }), accountLast4: number.slice(-4), accountHash: fingerprintSecret(number), status: 'active' });
  };
  const draftAndApprove = async (vendorId: string, invoiceId: string, methodId: string, amount = '464') => {
    const { id } = await c.vendorPayments.saveDraft(staff('clerk'), null, { kind: 'invoices', vendorId, methodId, narration: '', advanceId: '' }, [{ purchaseInvoiceId: invoiceId, amount }]);
    await c.vendorPayments.submit(staff('clerk'), id);
    await c.vendorPayments.approve(staff('boss'), id);
    return id;
  };
  const row = async (id: string) => required((await db.select().from(schema.vendorPaymentVouchers).where(eq(schema.vendorPaymentVouchers.id, id)))[0]);

  beforeAll(async () => {
    const { id: providerId } = await c.finance.paymentProviders.create(staff('reviewer'), { providerCode: 'mpesa_daraja', displayName: `MP ${run}` });
    const [base] = await db.select().from(schema.paymentMethods).where(eq(schema.paymentMethods.id, transfer));
    const [made] = await db.insert(schema.paymentMethods).values({ ...required(base), id: randomUUID(), code: `MPS${run}`.slice(0, 20).toUpperCase(), name: 'M-Pesa payout', kind: 'mobile_money', providerId }).returning();
    mpesaMethod = required(made).id;
  });

  it('pays a vendor’s M-Pesa phone: the voucher is fixed to that destination at approval, the plan is read from it, and the receipt records the payment', async () => {
    const none = await booked();
    expect(await codeOf(draftAndApprove(none.v.vendorId, none.pinv.id, mpesaMethod))).toBe('NO_BANK_ACCOUNT');
    const b = await booked();
    await destination(b.v.vendorId, 'mpesa_phone', '254712345678');
    const id = await draftAndApprove(b.v.vendorId, b.pinv.id, mpesaMethod);
    const v = await row(id);
    expect(v.destination).toBe('M-Pesa phone ending 5678');
    expect(await codeOf(c.vendorPayments.prepareMpesaPayout(staff('till'), id))).toBe('OK');
    const plan = await c.vendorPayments.prepareMpesaPayout(staff('till'), id);
    expect(plan).toMatchObject({ operation: 'b2c', amount: '464', number: v.number, attempt: 1 });
    expect(plan.input).toMatchObject({ phone: '254712345678', amount: '464', commandId: 'BusinessPayment' });
    // The platform says it failed: the voucher stays approved and says so.
    await c.vendorPayments.onAutomaticPayoutFinished(op(id, { status: 'failed', platformReference: null }));
    expect((await row(id)).status).toBe('approved');
    const events = await db.select().from(schema.vendorPaymentEvents).where(eq(schema.vendorPaymentEvents.voucherId, id));
    expect(events.some((e) => e.event === 'auto_payout_not_paid')).toBe(true);
    // The platform says it paid: the voucher is paid with the receipt, once.
    const receipt = op(id);
    await c.vendorPayments.onAutomaticPayoutFinished(receipt);
    const paid = await row(id);
    expect(paid).toMatchObject({ status: 'paid', paymentReference: receipt.platformReference });
    expect((await entryRemaining(b.pinv.ledgerEntryId))).toBe('0.00');
    await c.vendorPayments.onAutomaticPayoutFinished(receipt);
    expect((await db.select().from(schema.vendorPaymentVouchers).where(eq(schema.vendorPaymentVouchers.id, id))).length).toBe(1);
    expect((await c.payablesReports.reconcile(companyId)).ok).toBe(true);
    expect(await codeOf(c.vendorPayments.prepareMpesaPayout(staff('till'), id))).toBe('WRONG_STATE');
  });

  it('reads a paybill and a till from their destinations, and refuses what cannot go: cents, a third-person rule, a way of paying that is not M-Pesa', async () => {
    const b = await booked();
    await destination(b.v.vendorId, 'mpesa_paybill', '400200', 'ACC-77');
    const id = await draftAndApprove(b.v.vendorId, b.pinv.id, mpesaMethod, '100');
    const plan = await c.vendorPayments.prepareMpesaPayout(staff('till'), id);
    expect(plan).toMatchObject({ operation: 'b2b_paybill', amount: '100' });
    expect(plan.input).toMatchObject({ partyB: '400200', accountReference: 'ACC-77' });
    await c.vendorPayments.cancel(staff('clerk'), id, 'Test');
    const half = await draftAndApprove(b.v.vendorId, b.pinv.id, mpesaMethod, '100.50');
    expect(await codeOf(c.vendorPayments.prepareMpesaPayout(staff('till'), half))).toBe('AMOUNT_NOT_WHOLE');
    // A bank way of paying is not M-Pesa.
    const other = await booked();
    const bankId = await draftAndApprove(other.v.vendorId, other.pinv.id, transfer);
    expect(await codeOf(c.vendorPayments.prepareMpesaPayout(staff('till'), bankId))).toBe('NOT_MPESA');
    // The preparer cannot release a payment that needs three people.
    await c.purchaseOrders.saveSettings(staff('admin'), { rfqRequiredAbove: '', amendmentTolerancePercent: '0', paymentThreeEyesAbove: '50' });
    const big = await booked();
    await destination(big.v.vendorId, 'mpesa_till', '123456');
    const bigId = await draftAndApprove(big.v.vendorId, big.pinv.id, mpesaMethod);
    expect(await codeOf(c.vendorPayments.prepareMpesaPayout(staff('clerk'), bigId))).toBe('THREE_PEOPLE');
    expect(await codeOf(c.vendorPayments.prepareMpesaPayout(staff('till'), bigId))).toBe('OK');
    await c.purchaseOrders.saveSettings(staff('admin'), { rfqRequiredAbove: '', amendmentTolerancePercent: '0', paymentThreeEyesAbove: '100000' });
  });
});
