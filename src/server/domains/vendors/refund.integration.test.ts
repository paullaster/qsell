import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import { has, isRecord, readText, required } from '@/lib/values';
import { emptyBusiness, emptyFinancial, emptyProfile, type ProfileData } from '@/lib/vendor-profile';
import { emptyCategory } from '@/lib/prequalification';
import { emptyPoHeader, emptyPoLine, type PoLineForm } from '@/lib/purchase-order';
import type { RgnHeaderForm, RgnLineForm } from '@/lib/rgn';
import { emptyInvoiceHeader, type DeliveryNoteForm, type InvoiceLineForm } from '@/lib/supplier-invoice';
import type { RefundRequestForm } from '@/lib/vendor-refund';
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

describe.skipIf(!has(url))('vendor refunds (database)', () => {
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
    const [u] = await db.insert(schema.users).values({ email: `rf${String(seq)}.${run}@example.test`, passwordHash: 'x', name: 'Owner', role: 'vendor' }).returning();
    const vendorId = await c.vendors.registerBusiness({ companyId, userId: required(u).id, legalName: `RF Vendor ${run} ${String(seq)}`, email: `rf${String(seq)}.${run}@example.test`, phone: null });
    const a: PortalActor = { vendorId, userId: required(u).id, portalRole: 'owner' };
    const p = c.vendorProfile;
    const profile: ProfileData = { ...emptyProfile(), country: 'Kenya', description: 'We supply solar panels and inverters to businesses.', physicalStreet: '1 Mombasa Road', physicalCity: 'Nairobi', phone: '+254 700 000 000' };
    await p.saveProfile(a, profile);
    await p.saveBusiness(a, { ...emptyBusiness(), registrationNo: 'CPR/2012/12345', registrationDate: '2012-03-04', taxId: `G${String(Date.now()).slice(-9)}${String(seq % 10)}` });
    await p.addDirector(a, { name: 'Wanjiru Kamau', idType: 'national_id', idNumber: '12345678', sharePercent: '100' });
    await p.addBank(a, { bankName: 'KCB', branch: 'Moi Avenue', accountName: 'Acme Ltd', accountNumber: `0123${String(seq).padStart(6, '0')}`, swift: '' });
    await p.saveFinancial(a, { ...emptyFinancial(), offeredPaymentTermDays: '30' });
    await p.saveContacts(a, [{ name: 'Wanjiru Kamau', role: 'management', email: `rfw${String(seq)}.${run}@acme.test`, phone: '0700000000', isPrimary: true }]);
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
    await db.insert(schema.products).values({ id, sku: `RF-${run}-${String(prodSeq)}`.toUpperCase(), stockCode: `RFS-${run}-${String(prodSeq)}`.toUpperCase(), name: `Receiving ${String(prodSeq)}`, slug: `rf-${randomUUID()}`, itemTypeId, price: '999', costPrice: cost, stockQuantity: stock });
    return id;
  }

  /** A sent order with the lines given, for a qualified vendor; returns the order and its line ids. */
  async function sentOrder(v: PortalActor, lines: PoLineForm[], over: { currency?: string; confirm?: boolean; advance?: boolean } = {}) {
    catSeq += 1;
    const cat = await c.categories.save(companyId, null, { ...emptyCategory(), code: `RF${String(catSeq)}_${run}`.toUpperCase(), name: `RF category ${String(catSeq)} ${run}` });
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
    for (const name of ['refundRecorded']) stub[name] = (...args: unknown[]) => {
      noticed.push([name, ...args.map(String)]);
      return Promise.resolve();
    };
    (c.vendorRefunds as unknown as { notify?: unknown }).notify = stub;
    const [company] = await db
      .insert(schema.companySettings)
      .values({ legalName: 'RF', tradingName: 'RF', email: 'buyer@rf.test', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P' })
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



  /** A booked invoice for 4 units at the price given (tax 16%): the amount owed is 4 × price × 1.16. */
  async function booked(price = '100') {
    const s = await setup({ qty: '4', discount: '0' });
    const inv = await approved(s, price);
    await c.invoicePosting.post(staff('finance'), inv.id);
    const [p] = await db.select().from(schema.purchaseInvoices).where(eq(schema.purchaseInvoices.supplierInvoiceId, inv.id));
    return { ...s, inv, pinv: required(p) };
  }


  const today = new Date().toISOString().slice(0, 10);
  const balance = async (methodId: string) => {
    const [m] = await db.select().from(schema.paymentMethods).where(eq(schema.paymentMethods.id, methodId));
    return await db.select({ t: sql<string>`COALESCE(SUM(${schema.bankLedgerEntries.amount}), 0)::text` }).from(schema.bankLedgerEntries).where(eq(schema.bankLedgerEntries.bankAccountId, required(m).balancingBankAccountId)).then((r) => Number(required(r[0]).t));
  };
  /** A payment of 300 on account for a vendor with nothing to set it against. */
  async function onAccount(vendorId: string, amount = '300') {
    const { id } = await c.vendorPayments.saveDraft(staff('clerk'), null, { kind: 'on_account', vendorId, methodId: cash, advanceId: '', narration: 'Deposit', amount }, []);
    await c.vendorPayments.submit(staff('clerk'), id);
    await c.vendorPayments.approve(staff('boss'), id);
    await c.vendorPayments.pay(staff('till'), id, { reference: `OA-${String(++seq)}`, paidOn: today });
    return required((await db.select().from(schema.vendorPaymentVouchers).where(eq(schema.vendorPaymentVouchers.id, id)))[0]);
  }
  const creditOf = async (vendorId: string) => required((await c.vendorRefunds.refundable(companyId, vendorId))[0]);
  const form = (creditEntryId: string, over: Partial<RefundRequestForm> = {}): RefundRequestForm => ({ creditEntryId, methodId: cash, amount: '', note: '', ...over });
  const remainingOf = async (id: string) => required((await db.select().from(schema.vendorLedgerEntries).where(eq(schema.vendorLedgerEntries.id, id)))[0]).remainingAmount;

  it('is asked for by one person and booked by another, with the bank reference, and sets the credit off in the ledger and the books', async () => {
    const b = await booked();
    const paid = await onAccount(b.v.vendorId);
    const credit = await creditOf(b.v.vendorId);
    expect(credit).toMatchObject({ kind: 'payment', openCents: 30000, availableCents: 30000 });
    const before = await balance(cash);
    const asked = await c.vendorRefunds.request(staff('clerk'), form(credit.entryId, { amount: '120' }));
    expect(asked.amount).toBe('120.00');
    expect((await creditOf(b.v.vendorId)).availableCents).toBe(18000);
    expect(await codeOf(c.vendorRefunds.post(staff('clerk'), asked.id, { reference: 'TT-1', receivedOn: today }))).toBe('FOUR_EYES');
    expect(await codeOf(c.vendorRefunds.post(staff('boss'), asked.id, { reference: ' ', receivedOn: today }))).toBe('INVALID');
    expect(await codeOf(c.vendorRefunds.post(staff('boss'), asked.id, { reference: 'TT-1', receivedOn: '2999-01-01' }))).toBe('INVALID');
    const out = await c.vendorRefunds.post(staff('boss'), asked.id, { reference: 'TT-1', receivedOn: today });
    expect(out.number).toMatch(/^VRF-\d{4}-\d{5}$/);
    expect(noticed.find((n) => n[2] === out.number)).toEqual(['refundRecorded', b.v.vendorId, out.number, '120.00', 'KES', 'TT-1']);
    expect(await remainingOf(required(paid.ledgerEntryId))).toBe('-180.00');
    expect(await balance(cash)).toBe(before + 120);
    const accounts = await db.select().from(schema.glAccounts).where(eq(schema.glAccounts.companyId, companyId));
    const lines = await db.select().from(schema.glEntries).where(eq(schema.glEntries.registerId, out.registerId));
    expect(lines.map((e) => [accounts.find((a) => a.id === e.accountId)?.no, Number(e.debit), Number(e.credit)]).sort()).toEqual([['1110', 120, 0], ['2110', 0, 120]].sort());
    expect((await c.payablesReports.reconcile(companyId)).ok).toBe(true);
    expect(await c.finance.vendorLedger.drift(companyId)).toEqual([]);
    expect(await codeOf(c.vendorRefunds.post(staff('boss'), asked.id, { reference: 'TT-2', receivedOn: today }))).toBe('WRONG_STATE');
    expect(await codeOf(db.update(schema.vendorRefunds).set({ amount: '1.00' }).where(eq(schema.vendorRefunds.id, asked.id)))).toBe('23001');
    expect(await codeOf(db.delete(schema.vendorRefunds).where(eq(schema.vendorRefunds.id, asked.id)))).toBe('23001');
  });

  it('refuses more than is open or asked for, a credit that is not the vendor’s to refund, and a way of paying in another currency', async () => {
    const b = await booked();
    await onAccount(b.v.vendorId, '100');
    const credit = await creditOf(b.v.vendorId);
    expect(await codeOf(c.vendorRefunds.request(staff('clerk'), form(credit.entryId, { amount: '100.01' })))).toBe('INVALID');
    const first = await c.vendorRefunds.request(staff('clerk'), form(credit.entryId, { amount: '60' }));
    expect(await codeOf(c.vendorRefunds.request(staff('clerk'), form(credit.entryId, { amount: '60' })))).toBe('INVALID');
    await c.vendorRefunds.cancel(staff('clerk'), first.id, 'Asked twice');
    expect((await creditOf(b.v.vendorId)).availableCents).toBe(10000);
    expect(await codeOf(c.vendorRefunds.cancel(staff('clerk'), first.id, 'again'))).toBe('WRONG_STATE');
    // An invoice is not a credit to refund.
    const [invoice] = await db.select().from(schema.purchaseInvoices).where(eq(schema.purchaseInvoices.vendorId, b.v.vendorId));
    expect(await codeOf(c.vendorRefunds.request(staff('clerk'), form(required(invoice).ledgerEntryId)))).toBe('NOT_FOUND');
    expect(await codeOf(c.vendorRefunds.request(staff('clerk'), form(randomUUID())))).toBe('NOT_FOUND');
  });

  it('can be reversed with a reason: the credit is open again and the money is out of the bank’s ledger', async () => {
    const b = await booked();
    const paid = await onAccount(b.v.vendorId, '200');
    const credit = await creditOf(b.v.vendorId);
    const before = await balance(cash);
    const r = await c.vendorRefunds.request(staff('clerk'), form(credit.entryId));
    expect(r.amount).toBe('200.00');
    await c.vendorRefunds.post(staff('boss'), r.id, { reference: 'TT-9', receivedOn: today });
    expect(await remainingOf(required(paid.ledgerEntryId))).toBe('0.00');
    expect(await codeOf(c.vendorRefunds.reverse(staff('boss'), r.id, ' '))).toBe('NOTE_REQUIRED');
    await c.vendorRefunds.reverse(staff('boss'), r.id, 'The transfer bounced');
    expect(await remainingOf(required(paid.ledgerEntryId))).toBe('-200.00');
    expect(await balance(cash)).toBe(before);
    expect((await c.vendorRefunds.get(companyId, r.id))?.refund.status).toBe('reversed');
    expect(await codeOf(c.vendorRefunds.reverse(staff('boss'), r.id, 'again'))).toBe('NOT_POSTED');
    expect((await c.payablesReports.reconcile(companyId)).ok).toBe(true);
    expect(await c.finance.vendorLedger.drift(companyId)).toEqual([]);
    expect((await c.vendorRefunds.list(companyId, { vendorId: b.v.vendorId })).map((x) => x.status)).toEqual(['reversed']);
  });
});
