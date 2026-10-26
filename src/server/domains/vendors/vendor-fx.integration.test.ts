import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { has, isRecord, readText, required } from '@/lib/values';
import { emptyBusiness, emptyFinancial, emptyProfile, type ProfileData } from '@/lib/vendor-profile';
import { emptyCategory } from '@/lib/prequalification';
import { emptyPoHeader, emptyPoLine, type PoLineForm } from '@/lib/purchase-order';
import type { RgnHeaderForm, RgnLineForm } from '@/lib/rgn';
import { emptyInvoiceHeader, type DeliveryNoteForm, type InvoiceLineForm } from '@/lib/supplier-invoice';
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

describe.skipIf(!has(url))('foreign-currency vendor payments (database)', () => {
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
    const [u] = await db.insert(schema.users).values({ email: `fx${String(seq)}.${run}@example.test`, passwordHash: 'x', name: 'Owner', role: 'vendor' }).returning();
    const vendorId = await c.vendors.registerBusiness({ companyId, userId: required(u).id, legalName: `FX Vendor ${run} ${String(seq)}`, email: `fx${String(seq)}.${run}@example.test`, phone: null });
    const a: PortalActor = { vendorId, userId: required(u).id, portalRole: 'owner' };
    const p = c.vendorProfile;
    const profile: ProfileData = { ...emptyProfile(), country: 'Kenya', description: 'We supply solar panels and inverters to businesses.', physicalStreet: '1 Mombasa Road', physicalCity: 'Nairobi', phone: '+254 700 000 000' };
    await p.saveProfile(a, profile);
    await p.saveBusiness(a, { ...emptyBusiness(), registrationNo: 'CPR/2012/12345', registrationDate: '2012-03-04', taxId: `G${String(Date.now()).slice(-9)}${String(seq % 10)}` });
    await p.addDirector(a, { name: 'Wanjiru Kamau', idType: 'national_id', idNumber: '12345678', sharePercent: '100' });
    await p.addBank(a, { bankName: 'KCB', branch: 'Moi Avenue', accountName: 'Acme Ltd', accountNumber: `0123${String(seq).padStart(6, '0')}`, swift: '' });
    await p.saveFinancial(a, { ...emptyFinancial(), offeredPaymentTermDays: '30' });
    await p.saveContacts(a, [{ name: 'Wanjiru Kamau', role: 'management', email: `fxw${String(seq)}.${run}@acme.test`, phone: '0700000000', isPrimary: true }]);
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
    await db.insert(schema.products).values({ id, sku: `FX-${run}-${String(prodSeq)}`.toUpperCase(), stockCode: `FXS-${run}-${String(prodSeq)}`.toUpperCase(), name: `Receiving ${String(prodSeq)}`, slug: `fx-${randomUUID()}`, itemTypeId, price: '999', costPrice: cost, stockQuantity: stock });
    return id;
  }

  /** A sent order with the lines given, for a qualified vendor; returns the order and its line ids. */
  async function sentOrder(v: PortalActor, lines: PoLineForm[], over: { currency?: string; confirm?: boolean; advance?: boolean } = {}) {
    catSeq += 1;
    const cat = await c.categories.save(companyId, null, { ...emptyCategory(), code: `FX${String(catSeq)}_${run}`.toUpperCase(), name: `FX category ${String(catSeq)} ${run}` });
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
  async function setup(over: { qty?: string; receive?: string; discount?: string; currency?: string } = {}) {
    const v = await approvedVendor();
    const prod = await product(0, '10');
    const order = await sentOrder(v, [stockLine(prod, { quantity: over.qty ?? '10', discountPercent: over.discount ?? '0', unitPrice: '100' })], { confirm: true, currency: over.currency });
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
      .values({ legalName: 'FXT', tradingName: 'FXT', email: 'buyer@fx.test', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P' })
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



  const dayOf = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const setRate = async (date: string, rate: string) => {
    await db.insert(schema.exchangeRates).values({ companyId, currency: 'USD', effectiveOn: date, rate, createdBy: 'test' }).onConflictDoNothing();
  };
  let usdMethod = '';
  const gl = async (registerId: string) => {
    const accounts = await db.select().from(schema.glAccounts).where(eq(schema.glAccounts.companyId, companyId));
    const rows = await db.select().from(schema.glEntries).where(eq(schema.glEntries.registerId, registerId));
    return rows.map((e) => [accounts.find((a) => a.id === e.accountId)?.no, Number(e.baseDebit), Number(e.baseCredit)]).sort();
  };
  const entryOf = async (id: string) => required((await db.select().from(schema.vendorLedgerEntries).where(eq(schema.vendorLedgerEntries.id, id)))[0]);

  /** A USD order received, invoiced and booked on `bookedOn` (rates for the receipt day and the booking day must be set first). */
  async function bookedInUsd(bookedOn: Date) {
    const s = await setup({ qty: '4', discount: '0', currency: 'USD' });
    const inv = await approved(s, '100');
    await c.invoicePosting.post(staff('finance'), inv.id, bookedOn);
    const [p] = await db.select().from(schema.purchaseInvoices).where(eq(schema.purchaseInvoices.supplierInvoiceId, inv.id));
    return { ...s, pinv: required(p) };
  }

  const paymentFor = async (vendorId: string, methodId: string, invoiceId: string, amount: string, paidOn: string) => {
    const { id } = await c.vendorPayments.saveDraft(staff('clerk'), null, { kind: 'invoices', vendorId, methodId, narration: '', advanceId: '' }, [{ purchaseInvoiceId: invoiceId, amount }]);
    await c.vendorPayments.submit(staff('clerk'), id);
    await c.vendorPayments.approve(staff('boss'), id);
    await c.vendorPayments.pay(staff('till'), id, { reference: `USD-${String(++seq)}`, paidOn });
    return required((await db.select().from(schema.vendorPaymentVouchers).where(eq(schema.vendorPaymentVouchers.id, id)))[0]);
  };

  beforeAll(async () => {
    await db.insert(schema.currencies).values({ code: 'USD', name: 'US dollar', symbol: '$', isBaseCurrency: false }).onConflictDoNothing();
    const bank = await c.finance.bankAccounts.create(staff('reviewer'), { code: `FXB${run}`.toUpperCase().slice(0, 20), name: 'Dollar account', kind: 'bank', currency: 'USD' });
    const [base] = await db.select().from(schema.paymentMethods).where(eq(schema.paymentMethods.id, transfer));
    const [made] = await db.insert(schema.paymentMethods).values({ ...required(base), id: randomUUID(), code: `USD${run}`.slice(0, 20).toUpperCase(), name: 'Dollar transfer', balancingBankAccountId: bank.id }).returning();
    usdMethod = required(made).id;
    // Rates: 132 two days ago, 128 yesterday, 130 today.
    await setRate(dayOf(-2), '132');
    await setRate(dayOf(-1), '128');
    await setRate(dayOf(0), '130');
  });

  it('books a USD invoice at its day’s rate, and paying it at a higher rate is an exchange loss that closes the payables account', async () => {
    const b = await bookedInUsd(new Date(Date.now() - 86_400_000));
    const entry = await entryOf(b.pinv.ledgerEntryId);
    expect(entry).toMatchObject({ currency: 'USD', rate: '128.00000000', remainingAmount: '464.00' });
    expect((await c.payablesReports.reconcile(companyId)).ok).toBe(true);
    const paid = await paymentFor(b.v.vendorId, usdMethod, b.pinv.id, '464', dayOf(0));
    expect(paid).toMatchObject({ currency: 'USD', rate: '130.00000000', fxDifference: '-928.00' });
    // The payables account was debited 60,320.00 (464 × 130) but the invoice had credited 59,392.00 (464 × 128).
    expect(await gl(required(paid.registerId))).toEqual([['1120', 0, 60320], ['2110', 60320, 0]].sort());
    expect(await gl(required(paid.fxRegisterId))).toEqual([['2110', 0, 928], ['6700', 928, 0]].sort());
    expect((await entryOf(b.pinv.ledgerEntryId)).remainingAmount).toBe('0.00');
    expect(await entryOf(required(paid.ledgerEntryId))).toMatchObject({ currency: 'USD', rate: '130.00000000' });
    expect((await c.payablesReports.reconcile(companyId)).ok).toBe(true);
    expect(await c.finance.vendorLedger.drift(companyId)).toEqual([]);
    const bank = await db.select().from(schema.bankLedgerEntries).where(eq(schema.bankLedgerEntries.documentId, paid.id));
    expect(bank).toHaveLength(1);
    expect(bank[0]?.currency).toBe('USD');
    expect(Number(bank[0]?.amount)).toBe(-464);
    // Reversing puts everything back, including the exchange journal.
    await c.vendorPayments.reverse(staff('boss'), paid.id, 'Wrong account');
    expect((await entryOf(b.pinv.ledgerEntryId)).remainingAmount).toBe('464.00');
    expect((await c.payablesReports.reconcile(companyId)).ok).toBe(true);
  });

  it('paying at a lower rate is an exchange gain, and part payments each carry their own difference', async () => {
    const b = await bookedInUsd(new Date(Date.now() - 2 * 86_400_000));
    expect((await entryOf(b.pinv.ledgerEntryId)).rate).toBe('132.00000000');
    const first = await paymentFor(b.v.vendorId, usdMethod, b.pinv.id, '200', dayOf(0));
    expect(first.fxDifference).toBe('400.00');
    expect(await gl(required(first.fxRegisterId))).toEqual([['2110', 400, 0], ['4410', 0, 400]].sort());
    const second = await paymentFor(b.v.vendorId, usdMethod, b.pinv.id, '264', dayOf(-1));
    // Booked at 132, paid at 128: 264 × 4 = 1,056.
    expect(second.fxDifference).toBe('1056.00');
    expect((await entryOf(b.pinv.ledgerEntryId)).remainingAmount).toBe('0.00');
    expect((await c.payablesReports.reconcile(companyId)).ok).toBe(true);
  });

  it('refuses what cannot be paid yet: a way of paying in another currency than the invoice, a payment on account in dollars, and a day with no rate', async () => {
    const b = await bookedInUsd(new Date(Date.now() - 86_400_000));
    expect(await codeOf(c.vendorPayments.saveDraft(staff('clerk'), null, { kind: 'invoices', vendorId: b.v.vendorId, methodId: transfer, narration: '', advanceId: '' }, [{ purchaseInvoiceId: b.pinv.id, amount: '10' }]))).toBe('CURRENCY_MISMATCH');
    expect(await codeOf(c.vendorPayments.saveDraft(staff('clerk'), null, { kind: 'on_account', vendorId: b.v.vendorId, methodId: usdMethod, narration: 'Deposit', advanceId: '', amount: '10' }, []))).toBe('FOREIGN_CURRENCY');
    const { id } = await c.vendorPayments.saveDraft(staff('clerk'), null, { kind: 'invoices', vendorId: b.v.vendorId, methodId: usdMethod, narration: '', advanceId: '' }, [{ purchaseInvoiceId: b.pinv.id, amount: '10' }]);
    await c.vendorPayments.submit(staff('clerk'), id);
    await c.vendorPayments.approve(staff('boss'), id);
    expect(await codeOf(c.vendorPayments.pay(staff('till'), id, { reference: 'NORATE', paidOn: '2000-01-01' }))).toBe('NO_RATE');
  });

  it('revalues what is owed in dollars at today’s rate, keeps the ledger and the books in step while it stands, and undoes it the next day', async () => {
    const open = (await db.select().from(schema.vendorLedgerEntries).where(eq(schema.vendorLedgerEntries.companyId, companyId))).filter((e) => e.currency === 'USD' && Number(e.remainingAmount) !== 0);
    const expected = open.reduce((sum, e) => sum + Math.round(Number(e.remainingAmount) * 130 * 100) - Math.round(Number(e.remainingAmount) * Number(e.rate) * 100), 0);
    expect(expected).toBeGreaterThan(0);
    const out = await c.payablesFx.revalue(staff('finance'));
    expect(out.netCents).toBe(expected);
    expect(await codeOf(c.payablesFx.revalue(staff('finance')))).toBe('ALREADY_DONE');
    expect((await c.payablesReports.reconcile(companyId)).ok).toBe(true);
    expect((await c.payablesFx.last(companyId))?.reversed).toBe(false);
    // Nothing is undone on the day itself; the next day it is.
    expect(await c.payablesFx.reverseDue(new Date())).toBe(0);
    expect(await c.payablesFx.reverseDue(new Date(Date.now() + 2 * 86_400_000))).toBe(1);
    expect((await c.payablesFx.last(companyId))?.reversed).toBe(true);
    expect((await c.payablesReports.reconcile(companyId)).ok).toBe(true);
    expect(await codeOf(db.delete(schema.payablesRevaluations).where(eq(schema.payablesRevaluations.companyId, companyId)))).toBe('23001');
  });
});
