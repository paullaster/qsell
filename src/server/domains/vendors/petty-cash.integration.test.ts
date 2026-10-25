import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { has, isRecord, readText, required } from '@/lib/values';
import { emptyBusiness, emptyFinancial, emptyProfile, type ProfileData } from '@/lib/vendor-profile';
import { emptyCategory } from '@/lib/prequalification';
import { emptyPoHeader, emptyPoLine, type PoLineForm } from '@/lib/purchase-order';
import type { RgnHeaderForm, RgnLineForm } from '@/lib/rgn';
import { emptyInvoiceHeader, type DeliveryNoteForm, type InvoiceLineForm } from '@/lib/supplier-invoice';
import type { FloatForm, PettyVoucherForm } from '@/lib/petty-cash';
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

describe.skipIf(!has(url))('petty cash (database)', () => {
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
    const [u] = await db.insert(schema.users).values({ email: `pc${String(seq)}.${run}@example.test`, passwordHash: 'x', name: 'Owner', role: 'vendor' }).returning();
    const vendorId = await c.vendors.registerBusiness({ companyId, userId: required(u).id, legalName: `PC Vendor ${run} ${String(seq)}`, email: `pc${String(seq)}.${run}@example.test`, phone: null });
    const a: PortalActor = { vendorId, userId: required(u).id, portalRole: 'owner' };
    const p = c.vendorProfile;
    const profile: ProfileData = { ...emptyProfile(), country: 'Kenya', description: 'We supply solar panels and inverters to businesses.', physicalStreet: '1 Mombasa Road', physicalCity: 'Nairobi', phone: '+254 700 000 000' };
    await p.saveProfile(a, profile);
    await p.saveBusiness(a, { ...emptyBusiness(), registrationNo: 'CPR/2012/12345', registrationDate: '2012-03-04', taxId: `G${String(Date.now()).slice(-9)}${String(seq % 10)}` });
    await p.addDirector(a, { name: 'Wanjiru Kamau', idType: 'national_id', idNumber: '12345678', sharePercent: '100' });
    await p.addBank(a, { bankName: 'KCB', branch: 'Moi Avenue', accountName: 'Acme Ltd', accountNumber: `0123${String(seq).padStart(6, '0')}`, swift: '' });
    await p.saveFinancial(a, { ...emptyFinancial(), offeredPaymentTermDays: '30' });
    await p.saveContacts(a, [{ name: 'Wanjiru Kamau', role: 'management', email: `pcw${String(seq)}.${run}@acme.test`, phone: '0700000000', isPrimary: true }]);
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
    await db.insert(schema.products).values({ id, sku: `PC-${run}-${String(prodSeq)}`.toUpperCase(), stockCode: `PCS-${run}-${String(prodSeq)}`.toUpperCase(), name: `Receiving ${String(prodSeq)}`, slug: `pc-${randomUUID()}`, itemTypeId, price: '999', costPrice: cost, stockQuantity: stock });
    return id;
  }

  /** A sent order with the lines given, for a qualified vendor; returns the order and its line ids. */
  async function sentOrder(v: PortalActor, lines: PoLineForm[], over: { currency?: string; confirm?: boolean; advance?: boolean } = {}) {
    catSeq += 1;
    const cat = await c.categories.save(companyId, null, { ...emptyCategory(), code: `PC${String(catSeq)}_${run}`.toUpperCase(), name: `PC category ${String(catSeq)} ${run}` });
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
      .values({ legalName: 'PC', tradingName: 'PC', email: 'buyer@pc.test', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P' })
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



  /** A booked invoice for 4 units at the price given (tax 16%): the amount owed is 4 × price × 1.16. */
  async function booked(price = '100') {
    const s = await setup({ qty: '4', discount: '0' });
    const inv = await approved(s, price);
    await c.invoicePosting.post(staff('finance'), inv.id);
    const [p] = await db.select().from(schema.purchaseInvoices).where(eq(schema.purchaseInvoices.supplierInvoiceId, inv.id));
    return { ...s, inv, pinv: required(p) };
  }

  const remaining = async (entryId: string) => required((await db.select().from(schema.vendorLedgerEntries).where(eq(schema.vendorLedgerEntries.id, entryId)))[0]).remainingAmount;

  let cashGl = '';
  let expenseGl = '';
  let custodian = '';

  async function newFloat(over: Partial<FloatForm> = {}) {
    seq += 1;
    const bank = await c.finance.bankAccounts.create(staff('reviewer'), { code: `PCB${run}${String(seq)}`.toUpperCase().slice(0, 20), name: `Petty cash ${String(seq)}`, kind: 'cash', currency: 'KES' });
    const form: FloatForm = { code: `PC${run}${String(seq)}`.slice(0, 20), name: `Front office ${String(seq)}`, bankAccountId: bank.id, glAccountId: cashGl, custodianId: custodian, floatAmount: '10000', perVoucherLimit: '1000', dailyLimit: '1500', minimumBalance: '0', ...over };
    const made = await c.pettyCash.saveFloat(staff('admin'), null, form);
    return { id: made.id, bankId: bank.id, form };
  }
  /** A float funded to its amount through a top-up approved and paid by other people. */
  async function funded(over: Partial<FloatForm> = {}) {
    const f = await newFloat(over);
    const r = await c.pettyCash.requestReplenishment(staff('clerk'), { floatId: f.id, fromMethodId: transfer, amount: '', countNote: '' });
    await c.pettyCash.approveReplenishment(staff('boss'), r.id);
    await c.pettyCash.payReplenishment(staff('till'), r.id, { reference: 'WD-1' });
    return { ...f, firstTopUp: r };
  }
  const expenseForm = (floatId: string, over: Partial<PettyVoucherForm> = {}): PettyVoucherForm => ({ floatId, kind: 'expense', payeeName: 'Corner shop', description: 'Tea and sugar', receiptRef: `R-${String(++seq)}`, amount: '350', expenseAccountId: expenseGl, purchaseInvoiceId: '', ...over });
  const receipt = async (id: string) => await c.pettyCash.attach(staff('clerk'), id, { mediaAssetId: `media_${randomUUID()}`, fileName: 'receipt.jpg' });
  const balanceOf = async (bankId: string) => await c.pettyCash.balanceCents(db, bankId);
  async function paidVoucher(floatId: string, amount = '350') {
    const v = await c.pettyCash.saveDraft(staff('clerk'), null, expenseForm(floatId, { amount }));
    await receipt(v.id);
    await c.pettyCash.submit(staff('clerk'), v.id);
    const { number } = await c.pettyCash.approve(staff('boss'), v.id);
    await c.pettyCash.pay(staff('custodian'), v.id);
    return { ...v, number };
  }
  const glLines = async (registerId: string) => {
    const accounts = await db.select().from(schema.glAccounts).where(eq(schema.glAccounts.companyId, companyId));
    const rows = await db.select().from(schema.glEntries).where(eq(schema.glEntries.registerId, registerId));
    return rows.map((e) => [accounts.find((a) => a.id === e.accountId)?.no, Number(e.debit), Number(e.credit)]).sort();
  };
  const row = async (id: string) => required((await db.select().from(schema.pettyCashVouchers).where(eq(schema.pettyCashVouchers.id, id)))[0]);

  beforeAll(async () => {
    const accounts = await db.select().from(schema.glAccounts).where(eq(schema.glAccounts.companyId, companyId));
    cashGl = required(accounts.find((a) => a.no === '1110')).id;
    expenseGl = required(accounts.find((a) => a.no === '6200')).id;
    const [u] = await db.insert(schema.users).values({ email: `custodian.${run}@example.test`, passwordHash: 'x', name: 'Custodian', role: 'manager' }).returning();
    custodian = required(u).id;
  });

  describe('a float', () => {
    it('needs an open cash account of its own, an asset account for the cash and an active member of staff, with sensible limits', async () => {
      const f = await newFloat();
      const [again] = await db.select().from(schema.pettyCashFloats).where(eq(schema.pettyCashFloats.id, f.id));
      expect(again).toMatchObject({ floatAmount: '10000.00', perVoucherLimit: '1000.00', dailyLimit: '1500.00', currency: 'KES' });
      expect(await codeOf(c.pettyCash.saveFloat(staff('admin'), null, { ...f.form, code: `X${run}` }))).toBe('DUPLICATE');
      const bank = await c.finance.bankAccounts.create(staff('reviewer'), { code: `PCX${run}`.toUpperCase().slice(0, 20), name: 'Not cash', kind: 'bank', currency: 'KES' });
      expect(await codeOf(c.pettyCash.saveFloat(staff('admin'), null, { ...f.form, code: `Y${run}`, bankAccountId: bank.id }))).toBe('INVALID');
      expect(await codeOf(c.pettyCash.saveFloat(staff('admin'), null, { ...f.form, code: `Z${run}`, custodianId: randomUUID() }))).toBe('INVALID');
      expect(await codeOf(c.pettyCash.saveFloat(staff('admin'), null, { ...f.form, code: `W${run}`, dailyLimit: '10' }))).toBe('INVALID');
      const list = await c.pettyCash.floats(companyId);
      expect(list.find((x) => x.id === f.id)).toMatchObject({ balanceCents: 0, spentTodayCents: 0, custodianName: 'Custodian' });
    });
  });

  describe('filling the float', () => {
    it('is a top-up approved by another person and paid with a reference, moving money from the bank to the float', async () => {
      const f = await newFloat();
      const r = await c.pettyCash.requestReplenishment(staff('clerk'), { floatId: f.id, fromMethodId: transfer, amount: '', countNote: 'Opening cash' });
      expect(r).toMatchObject({ amount: '10000.00' });
      expect(r.number).toMatch(/^PCR-\d{4}-\d{5}$/);
      expect(await codeOf(c.pettyCash.requestReplenishment(staff('clerk'), { floatId: f.id, fromMethodId: transfer, amount: '1', countNote: '' }))).toBe('FULL');
      expect(await codeOf(c.pettyCash.approveReplenishment(staff('clerk'), r.id))).toBe('FOUR_EYES');
      expect(await codeOf(c.pettyCash.payReplenishment(staff('till'), r.id, { reference: 'X' }))).toBe('WRONG_STATE');
      await c.pettyCash.approveReplenishment(staff('boss'), r.id);
      expect(await codeOf(c.pettyCash.payReplenishment(staff('till'), r.id, { reference: ' ' }))).toBe('REFERENCE_REQUIRED');
      const out = await c.pettyCash.payReplenishment(staff('till'), r.id, { reference: 'WD-77' });
      expect(await balanceOf(f.bankId)).toBe(1_000_000);
      const topUp = await glLines(out.registerId);
      expect(topUp).toHaveLength(2);
      expect(topUp).toEqual(expect.arrayContaining([['1110', 10000, 0], ['1120', 0, 10000]]));
      expect(await codeOf(c.pettyCash.requestReplenishment(staff('clerk'), { floatId: f.id, fromMethodId: transfer, amount: '', countNote: '' }))).toBe('FULL');
      expect(await codeOf(db.update(schema.pettyCashReplenishments).set({ amount: '1.00' }).where(eq(schema.pettyCashReplenishments.id, r.id)))).toBe('23001');
      expect(await codeOf(db.delete(schema.pettyCashReplenishments).where(eq(schema.pettyCashReplenishments.id, r.id)))).toBe('23001');
    });
  });

  describe('a voucher', () => {
    it('needs a receipt, another person’s approval and the cash, and takes the money out of the float and the books', async () => {
      const f = await funded();
      expect(await codeOf(c.pettyCash.saveDraft(staff('clerk'), null, expenseForm(f.id, { amount: '1000.01' })))).toBe('OVER_LIMIT');
      expect(await codeOf(c.pettyCash.saveDraft(staff('clerk'), null, expenseForm(f.id, { expenseAccountId: cashGl })))).toBe('INVALID');
      const v = await c.pettyCash.saveDraft(staff('clerk'), null, expenseForm(f.id));
      expect(await codeOf(c.pettyCash.submit(staff('clerk'), v.id))).toBe('RECEIPT_REQUIRED');
      await receipt(v.id);
      await c.pettyCash.submit(staff('clerk'), v.id);
      expect(await codeOf(c.pettyCash.approve(staff('clerk'), v.id))).toBe('FOUR_EYES');
      expect(await codeOf(db.update(schema.pettyCashVouchers).set({ status: 'approved', approvedBy: 'clerk' }).where(eq(schema.pettyCashVouchers.id, v.id)))).toBe('23514');
      expect(await codeOf(c.pettyCash.pay(staff('custodian'), v.id))).toBe('WRONG_STATE');
      const { number } = await c.pettyCash.approve(staff('boss'), v.id);
      expect(number).toMatch(/^PCV-\d{4}-\d{5}$/);
      const paid = await c.pettyCash.pay(staff('custodian'), v.id);
      expect(await glLines(paid.registerId)).toEqual([['1110', 0, 350], ['6200', 350, 0]].sort());
      expect(await balanceOf(f.bankId)).toBe(1_000_000 - 35_000);
      expect(await codeOf(c.pettyCash.pay(staff('custodian'), v.id))).toBe('WRONG_STATE');
      expect(await codeOf(db.update(schema.pettyCashVouchers).set({ amount: '1.00' }).where(eq(schema.pettyCashVouchers.id, v.id)))).toBe('23001');
      expect(await codeOf(db.delete(schema.pettyCashVouchers).where(eq(schema.pettyCashVouchers.id, v.id)))).toBe('23001');
      expect((await c.pettyCash.floats(companyId)).find((x) => x.id === f.id)).toMatchObject({ balanceCents: 965_000, spentTodayCents: 35_000, uncovered: 1 });
    });

    it('respects the day’s limit, the cash in the float, and a float that has fallen below its minimum', async () => {
      const f = await funded({ dailyLimit: '1500', minimumBalance: '9500' });
      // Written while the float is still above its minimum.
      const second = await c.pettyCash.saveDraft(staff('clerk'), null, expenseForm(f.id, { amount: '600' }));
      await paidVoucher(f.id, '1000');
      expect(await codeOf(c.pettyCash.saveDraft(staff('clerk'), null, expenseForm(f.id, { amount: '100' })))).toBe('FLOAT_LOW');
      await receipt(second.id);
      expect(await codeOf(c.pettyCash.submit(staff('clerk'), second.id))).toBe('FLOAT_LOW');
      await c.pettyCash.cancel(staff('clerk'), second.id, 'Float is low');
      // Without a minimum, the day's limit still applies.
      const g = await funded({ dailyLimit: '1500', minimumBalance: '0' });
      await paidVoucher(g.id, '1000');
      const third = await c.pettyCash.saveDraft(staff('clerk'), null, expenseForm(g.id, { amount: '600' }));
      await receipt(third.id);
      await c.pettyCash.submit(staff('clerk'), third.id);
      expect(await codeOf(c.pettyCash.approve(staff('boss'), third.id))).toBe('OVER_DAILY');
      // Not more cash than there is.
      const h = await funded({ floatAmount: '1000', perVoucherLimit: '1000', dailyLimit: '5000' });
      await paidVoucher(h.id, '800');
      const fourth = await c.pettyCash.saveDraft(staff('clerk'), null, expenseForm(h.id, { amount: '500' }));
      await receipt(fourth.id);
      await c.pettyCash.submit(staff('clerk'), fourth.id);
      await c.pettyCash.approve(staff('boss'), fourth.id);
      expect(await codeOf(c.pettyCash.pay(staff('custodian'), fourth.id))).toBe('NOT_ENOUGH_CASH');
    });

    it('pays a small vendor invoice, sets it against the ledger, and a reversal opens it again and puts the cash back', async () => {
      const b = await booked();
      const f = await funded({ perVoucherLimit: '500', dailyLimit: '5000' });
      const v = await c.pettyCash.saveDraft(staff('clerk'), null, { floatId: f.id, kind: 'vendor_invoice', payeeName: b.v.vendorId.slice(0, 8), description: 'Small invoice', receiptRef: 'INV-R', amount: '464', expenseAccountId: '', purchaseInvoiceId: b.pinv.id });
      await receipt(v.id);
      await c.pettyCash.submit(staff('clerk'), v.id);
      await c.pettyCash.approve(staff('boss'), v.id);
      const paid = await c.pettyCash.pay(staff('custodian'), v.id);
      expect(await glLines(paid.registerId)).toEqual([['1110', 0, 464], ['2110', 464, 0]].sort());
      expect(await remaining(b.pinv.ledgerEntryId)).toBe('0.00');
      expect((await c.payablesReports.reconcile(companyId)).ok).toBe(true);
      await c.pettyCash.reverse(staff('boss'), v.id, 'Paid the wrong invoice');
      expect(await remaining(b.pinv.ledgerEntryId)).toBe('464.00');
      expect(await balanceOf(f.bankId)).toBe(1_000_000);
      const after = await row(v.id);
      expect(after.status).toBe('reversed');
      const bank = await db.select().from(schema.bankLedgerEntries).where(eq(schema.bankLedgerEntries.documentId, v.id));
      expect(bank.map((e) => e.documentType).sort()).toEqual(['petty_cash', 'petty_cash_reversal']);
      expect(await c.finance.vendorLedger.drift(companyId)).toEqual([]);
      expect((await c.payablesReports.reconcile(companyId)).ok).toBe(true);
      // More than the invoice has open is refused when written.
      expect(await codeOf(c.pettyCash.saveDraft(staff('clerk'), null, { floatId: f.id, kind: 'vendor_invoice', payeeName: 'x', description: 'x', receiptRef: 'x', amount: '470', expenseAccountId: '', purchaseInvoiceId: b.pinv.id }))).toBe('INVALID');
    });
  });

  describe('topping up', () => {
    it('covers the vouchers paid since the last top-up, tops the float back up, and a covered payment cannot be reversed', async () => {
      const f = await funded();
      const one = await paidVoucher(f.id, '400');
      const two = await paidVoucher(f.id, '250');
      const r = await c.pettyCash.requestReplenishment(staff('clerk'), { floatId: f.id, fromMethodId: transfer, amount: '', countNote: 'Counted 9350.00' });
      expect(r.amount).toBe('650.00');
      expect((await row(one.id)).replenishmentId).toBe(r.id);
      expect(await codeOf(c.pettyCash.reverse(staff('boss'), two.id, 'Mistake'))).toBe('COVERED');
      await c.pettyCash.cancelReplenishment(staff('clerk'), r.id, 'Wrong bank');
      expect((await row(one.id)).replenishmentId).toBeNull();
      const again = await c.pettyCash.requestReplenishment(staff('clerk'), { floatId: f.id, fromMethodId: transfer, amount: '', countNote: '' });
      await c.pettyCash.approveReplenishment(staff('boss'), again.id);
      await c.pettyCash.payReplenishment(staff('till'), again.id, { reference: 'WD-2' });
      expect(await balanceOf(f.bankId)).toBe(1_000_000);
      expect((await c.pettyCash.floatDetail(companyId, f.id))?.replenishments.map((x) => x.status).sort()).toEqual(['cancelled', 'paid', 'paid']);
    });
  });
});
