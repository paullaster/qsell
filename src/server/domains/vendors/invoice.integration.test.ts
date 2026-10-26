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

describe.skipIf(!has(url))('supplier invoices (database)', () => {
  let db: DrizzleDb;
  let schema: typeof mod_schema;
  let c: AppContainer;
  let companyId: string;
  let unit: { code: string; name: string };
  let inputTax = '';
  let expense = '';
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
    const [u] = await db.insert(schema.users).values({ email: `si${String(seq)}.${run}@example.test`, passwordHash: 'x', name: 'Owner', role: 'vendor' }).returning();
    const vendorId = await c.vendors.registerBusiness({ companyId, userId: required(u).id, legalName: `SI Vendor ${run} ${String(seq)}`, email: `si${String(seq)}.${run}@example.test`, phone: null });
    const a: PortalActor = { vendorId, userId: required(u).id, portalRole: 'owner' };
    const p = c.vendorProfile;
    const profile: ProfileData = { ...emptyProfile(), country: 'Kenya', description: 'We supply solar panels and inverters to businesses.', physicalStreet: '1 Mombasa Road', physicalCity: 'Nairobi', phone: '+254 700 000 000' };
    await p.saveProfile(a, profile);
    await p.saveBusiness(a, { ...emptyBusiness(), registrationNo: 'CPR/2012/12345', registrationDate: '2012-03-04', taxId: `G${String(Date.now()).slice(-9)}${String(seq % 10)}` });
    await p.addDirector(a, { name: 'Wanjiru Kamau', idType: 'national_id', idNumber: '12345678', sharePercent: '100' });
    await p.addBank(a, { bankName: 'KCB', branch: 'Moi Avenue', accountName: 'Acme Ltd', accountNumber: `0123${String(seq).padStart(6, '0')}`, swift: '' });
    await p.saveFinancial(a, { ...emptyFinancial(), offeredPaymentTermDays: '30' });
    await p.saveContacts(a, [{ name: 'Wanjiru Kamau', role: 'management', email: `sw${String(seq)}.${run}@acme.test`, phone: '0700000000', isPrimary: true }]);
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
    await db.insert(schema.products).values({ id, sku: `SI-${run}-${String(prodSeq)}`.toUpperCase(), stockCode: `SIS-${run}-${String(prodSeq)}`.toUpperCase(), name: `Receiving ${String(prodSeq)}`, slug: `si-${randomUUID()}`, itemTypeId, price: '999', costPrice: cost, stockQuantity: stock });
    return id;
  }

  /** A sent order with the lines given, for a qualified vendor; returns the order and its line ids. */
  async function sentOrder(v: PortalActor, lines: PoLineForm[], over: { currency?: string; confirm?: boolean } = {}) {
    catSeq += 1;
    const cat = await c.categories.save(companyId, null, { ...emptyCategory(), code: `SI${String(catSeq)}_${run}`.toUpperCase(), name: `SI category ${String(catSeq)} ${run}` });
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
      .values({ legalName: 'SI', tradingName: 'SI', email: 'buyer@si.test', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P' })
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
      .values({ legalName: 'SI', tradingName: 'SI', email: 'buyer@si.test', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P' })
      .returning();
    companyId = required(company).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    await c.finance.setup.applyTemplate(staff('reviewer'), 'kenya', { fiscalYearStart: '2026-01-01' });
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    await db.update(schema.financeSettings).set({ inventoryGlGoLive: '2026-01-01' }).where(eq(schema.financeSettings.companyId, companyId));
    const accounts = await db.select().from(schema.glAccounts).where(eq(schema.glAccounts.companyId, companyId));
    inputTax = required(accounts.find((a) => a.no === '1410')).id;
    expense = required(accounts.find((a) => a.no === '6200')).id;
    await db.insert(schema.vendorSettings).values({ companyId, inputTaxAccountId: inputTax }).onConflictDoUpdate({ target: schema.vendorSettings.companyId, set: { inputTaxAccountId: inputTax } });
    const probe = await product(0, '1');
    const [p] = await db.select({ unitId: schema.products.baseUnitId }).from(schema.products).where(eq(schema.products.id, probe));
    const [u] = await db.select({ code: schema.unitsOfMeasure.code, name: schema.unitsOfMeasure.name }).from(schema.unitsOfMeasure).where(eq(schema.unitsOfMeasure.id, required(p).unitId));
    unit = required(u);
  });

  describe('starting and sending (the vendor)', () => {
    it('starts from what was received, refuses a repeated number, and only an owner or finance person writes', async () => {
      const s = await setup({ qty: '10', receive: '6', discount: '10' });
      const no = `INV-${run}-A`;
      const { id } = await c.invoicePortal.start(s.v, companyId, { poId: s.order.id, vendorInvoiceNo: no });
      const loaded = await c.invoicePortal.load(s.v, id);
      expect(loaded).toMatchObject({ state: 'draft', currency: 'KES', total: '626.40', subtotal: '540.00', taxTotal: '86.40' });
      expect(loaded.lines[0]).toMatchObject({ quantity: '6.000', unitPrice: '90.00', goodsRoom: '6' });
      expect(await codeOf(c.invoicePortal.start(s.v, companyId, { poId: s.order.id, vendorInvoiceNo: ` ${no.toLowerCase()} ` }))).toBe('DUPLICATE');
      expect(await codeOf(c.invoicePortal.start({ ...s.v, portalRole: 'sales' }, companyId, { poId: s.order.id, vendorInvoiceNo: 'X-1' }))).toBe('NOT_ALLOWED');
      // Another vendor cannot see or touch it.
      const other = await approvedVendor();
      expect(await codeOf(c.invoicePortal.load(other, id))).toBe('NOT_FOUND');
      expect(await codeOf(c.invoicePortal.start(other, companyId, { poId: s.order.id, vendorInvoiceNo: 'Y-1' }))).toBe('NOT_FOUND');
      // Nothing received, nothing to invoice.
      const empty = await sentOrder(s.v, [stockLine(s.prod)], { confirm: true });
      expect(await codeOf(c.invoicePortal.start(s.v, companyId, { poId: empty.id, vendorInvoiceNo: 'Z-1' }))).toBe('NOTHING_TO_INVOICE');
    });

    it('works out the totals itself and refuses to send until the rules are met, each with a plain message', async () => {
      const s = await setup();
      const { id } = await c.invoicePortal.start(s.v, companyId, { poId: s.order.id, vendorInvoiceNo: `INV-${run}-B` });
      const e = await c.invoicePortal.submit(s.v, companyId, id).catch((x: unknown) => x as { code: string; problems: Record<string, string> });
      expect(e).toMatchObject({ code: 'INVALID' });
      expect(Object.keys((e as { problems: Record<string, string> }).problems)).toEqual(expect.arrayContaining(['declaration', 'invoiceFile', 'notes']));
      expect((e as { problems: Record<string, string> }).problems.notes).toMatch(/not set up for advance payment/);
      const scan = await file(s.v);
      const dnFile = await file(s.v);
      const saved = await c.invoicePortal.save(s.v, id, { header: { ...emptyInvoiceHeader(TODAY), vendorInvoiceNo: `INV-${run}-B`, declaration: true }, lines: lineForms([[s.line, '4', '25.50']]), deliveryNotes: [noteForm(s.note, dnFile)], invoiceFileId: scan });
      expect(saved).toEqual({ subtotal: '102.00', taxTotal: '16.32', total: '118.32' });
      // More than was received.
      await c.invoicePortal.save(s.v, id, { header: { ...emptyInvoiceHeader(TODAY), vendorInvoiceNo: `INV-${run}-B`, declaration: true }, lines: lineForms([[s.line, '11', '100']]), deliveryNotes: [noteForm(s.note, dnFile)], invoiceFileId: scan });
      const over = await c.invoicePortal.submit(s.v, companyId, id).catch((x: unknown) => x as { problems: Record<string, string> });
      expect((over as { problems: Record<string, string> }).problems['line.0.quantity']).toMatch(/received and not invoiced/);
      // Someone else's file cannot be attached.
      const other = await approvedVendor();
      const theirs = await file(other);
      expect(await codeOf(c.invoicePortal.save(s.v, id, { header: { ...emptyInvoiceHeader(TODAY), vendorInvoiceNo: `INV-${run}-B`, declaration: true }, lines: lineForms([[s.line, '4', '25']]), deliveryNotes: [], invoiceFileId: theirs }))).toBe('FILE');
    });

    it('sends with our number, and a vendor cannot change it afterwards; a blocked vendor cannot send', async () => {
      const s = await setup();
      const inv = await submitted(s);
      expect(inv.number).toMatch(/^SINV-\d{4}-\d{5}$/);
      const view = await c.invoicePortal.load(s.v, inv.id);
      expect(view).toMatchObject({ state: 'submitted', editable: false, canRecall: true });
      expect(await codeOf(c.invoicePortal.save(s.v, inv.id, { header: { ...emptyInvoiceHeader(TODAY), vendorInvoiceNo: 'ZZ', declaration: true }, lines: lineForms([[s.line, '1', '1']]), deliveryNotes: [], invoiceFileId: '' }))).toBe('LOCKED');
      expect(await codeOf(c.invoicePortal.submit(s.v, companyId, inv.id))).toBe('LOCKED');
      expect(await codeOf(c.invoicePortal.close(s.v, inv.id, 'No longer needed'))).toBe('LOCKED');
      const t = await setup();
      const { id } = await c.invoicePortal.start(t.v, companyId, { poId: t.order.id, vendorInvoiceNo: `INV-${run}-C` });
      await db.update(schema.vendors).set({ block: 'all' }).where(eq(schema.vendors.id, t.v.vendorId));
      expect(await codeOf(c.invoicePortal.submit(t.v, companyId, id))).toBe('VENDOR_NOT_ACTIVE');
      await db.update(schema.vendors).set({ block: 'none' }).where(eq(schema.vendors.id, t.v.vendorId));
    });

    it('closing needs a reason and frees the number; a refused invoice frees it too', async () => {
      const s = await setup();
      const no = `INV-${run}-D`;
      const { id } = await c.invoicePortal.start(s.v, companyId, { poId: s.order.id, vendorInvoiceNo: no });
      expect(await codeOf(c.invoicePortal.close(s.v, id, ' '))).toBe('NOTE_REQUIRED');
      await c.invoicePortal.close(s.v, id, 'Raised by mistake');
      expect((await c.invoicePortal.load(s.v, id)).state).toBe('closed');
      expect(await codeOf(c.invoicePortal.start(s.v, companyId, { poId: s.order.id, vendorInvoiceNo: no }))).toBe('OK');
      expect(await codeOf(db.update(schema.supplierInvoices).set({ state: 'draft' }).where(eq(schema.supplierInvoices.id, id)))).toBe('23001');
    });
  });

  describe('taking it back', () => {
    it('is possible only while nobody has touched it, whichever of the two acts first', async () => {
      const s = await setup();
      const a = await submitted(s);
      await c.invoicePortal.recall(s.v, a.id);
      const back = await c.invoicePortal.load(s.v, a.id);
      expect(back).toMatchObject({ state: 'draft', number: a.number, editable: true });
      const events = await db.select().from(schema.supplierInvoiceEvents).where(eq(schema.supplierInvoiceEvents.invoiceId, a.id));
      expect(events.find((x) => x.event === 'recalled')?.data).toMatchObject({ number: a.number });
      expect(await codeOf(c.supplierInvoices.pickUp(staff('clerk'), a.id))).toBe('NOT_FOUND');
      const again = await c.invoicePortal.submit(s.v, companyId, a.id);
      expect(again.number).toBe(a.number);

      // Staff first: the recall loses, and says so.
      const t = await setup();
      const b = await submitted(t);
      await c.supplierInvoices.pickUp(staff('clerk'), b.id);
      expect(await codeOf(c.invoicePortal.recall(t.v, b.id))).toBe('TOO_LATE');
      expect(await codeOf(c.supplierInvoices.pickUp(staff('other'), b.id))).toBe('WRONG_STATE');

      // Both at once: exactly one wins.
      const u = await setup();
      const d = await submitted(u);
      const results = await Promise.all([codeOf(c.invoicePortal.recall(u.v, d.id)), codeOf(c.supplierInvoices.pickUp(staff('clerk'), d.id))]);
      expect(results.filter((r) => r === 'OK')).toHaveLength(1);
    });
  });

  describe('the staff stages', () => {
    it('links the received goods and delivery notes, refusing links that do not belong, then checks and approves; the person who linked cannot approve', async () => {
      const s = await setup();
      const inv = await submitted(s);
      expect(await codeOf(c.supplierInvoices.saveLinks(staff('clerk'), inv.id, { links: [], accounts: [], notes: [] }))).toBe('WRONG_STATE');
      await c.supplierInvoices.pickUp(staff('clerk'), inv.id);
      const detail = required(await c.supplierInvoices.get(companyId, inv.id));
      const goods = required(detail.candidates[0]);
      const line = required(detail.lines[0]);
      expect(await codeOf(c.supplierInvoices.saveLinks(staff('clerk'), inv.id, { links: [{ lineId: line.id, rgnLineId: goods.rgnLineId, quantity: '11' }], accounts: [], notes: [] }))).toBe('TOO_MUCH');
      expect(await codeOf(c.supplierInvoices.saveLinks(staff('clerk'), inv.id, { links: [{ lineId: line.id, rgnLineId: randomUUID(), quantity: '1' }], accounts: [], notes: [] }))).toBe('INVALID');
      // Not complete: the delivery note is not matched yet.
      const partial = await c.supplierInvoices.saveLinks(staff('clerk'), inv.id, { links: [{ lineId: line.id, rgnLineId: goods.rgnLineId, quantity: '10' }], accounts: [], notes: [] });
      expect(partial.complete).toBe(false);
      expect(partial.missing[0]).toMatch(/not matched/);
      expect(await codeOf(c.supplierInvoices.runMatch(staff('clerk'), inv.id))).toBe('WRONG_STATE');
      // A delivery note matched to a note with a different number is refused.
      const note = required(detail.deliveryNotes[0]);
      const wrong = await receive(s.order.id, [rl(s.line, '0.001')]).catch(() => null);
      expect(wrong).toBeNull();
      const done = await c.supplierInvoices.saveLinks(staff('clerk'), inv.id, { links: [{ lineId: line.id, rgnLineId: goods.rgnLineId, quantity: '10' }], accounts: [], notes: [{ noteId: note.id, rgnId: goods.rgnId }] });
      expect(done.complete).toBe(true);
      expect(await c.supplierInvoices.runMatch(staff('clerk'), inv.id)).toMatchObject({ ok: true, exceptions: 0 });
      await c.supplierInvoices.sendForApproval(staff('clerk'), inv.id);
      expect(await codeOf(c.supplierInvoices.approve(staff('clerk'), inv.id))).toBe('FOUR_EYES');
      // The database says the same, whatever the service does.
      expect(await codeOf(db.update(schema.supplierInvoices).set({ state: 'approved', approvedBy: 'clerk' }).where(eq(schema.supplierInvoices.id, inv.id)))).toBe('23514');
      await c.supplierInvoices.approve(staff('boss'), inv.id);
      expect(required(await c.supplierInvoices.get(companyId, inv.id)).invoice.state).toBe('approved');
    });

    it('holds the goods an invoice links so a second invoice cannot take them', async () => {
      const s = await setup({ qty: '10', receive: '10' });
      const a = await submitted(s, undefined, '100', '6');
      const b = await submitted(s, undefined, '100', '4');
      await c.supplierInvoices.pickUp(staff('clerk'), a.id);
      await c.supplierInvoices.pickUp(staff('clerk'), b.id);
      const da = required(await c.supplierInvoices.get(companyId, a.id));
      const goods = required(da.candidates[0]);
      await c.supplierInvoices.saveLinks(staff('clerk'), a.id, { links: [{ lineId: required(da.lines[0]).id, rgnLineId: goods.rgnLineId, quantity: '6' }], accounts: [], notes: [] });
      const detailB = required(await c.supplierInvoices.get(companyId, b.id));
      expect(required(detailB.candidates[0]).room).toBe('4');
      expect(await codeOf(c.supplierInvoices.saveLinks(staff('clerk'), b.id, { links: [{ lineId: required(detailB.lines[0]).id, rgnLineId: goods.rgnLineId, quantity: '5' }], accounts: [], notes: [] }))).toBe('TOO_MUCH');
      // A third invoice cannot even be sent for more than is left.
      const s3 = await c.invoicePortal.start(s.v, companyId, { poId: s.order.id, vendorInvoiceNo: `INV-${run}-E` }).catch((x: unknown) => x as { code: string });
      expect((s3 as { code?: string }).code ?? 'OK').toBe('NOTHING_TO_INVOICE');
    });

    it('finds a price above the order beyond the tolerance, and lets only a reasoned override pass it', async () => {
      const s = await setup();
      const inv = await submitted(s, undefined, '140');
      await c.supplierInvoices.pickUp(staff('clerk'), inv.id);
      await c.supplierInvoices.autoLink(staff('clerk'), inv.id);
      const out = await c.supplierInvoices.runMatch(staff('clerk'), inv.id);
      expect(out).toMatchObject({ ok: false, exceptions: 1 });
      const d = required(await c.supplierInvoices.get(companyId, inv.id));
      expect(d.invoice.state).toBe('rgn_linked');
      expect(required(d.lines[0]).match?.problems[0]).toMatch(/above the order by 400.00/);
      expect(await codeOf(c.supplierInvoices.sendForApproval(staff('clerk'), inv.id))).toBe('WRONG_STATE');
      expect(await codeOf(c.supplierInvoices.override(staff('lead'), inv.id, ' '))).toBe('NOTE_REQUIRED');
      await c.supplierInvoices.override(staff('lead'), inv.id, 'Price rise agreed by phone');
      expect(required(await c.supplierInvoices.get(companyId, inv.id)).invoice).toMatchObject({ state: 'matched', matchOverrideReason: 'Price rise agreed by phone' });
    });

    it('sends back with a reason and clears the staff work; the vendor corrects it and sends it again as the next revision with the same number', async () => {
      const s = await setup();
      const inv = await submitted(s);
      await c.supplierInvoices.pickUp(staff('clerk'), inv.id);
      await c.supplierInvoices.autoLink(staff('clerk'), inv.id);
      expect(await codeOf(c.supplierInvoices.returnToVendor(staff('clerk'), inv.id, 'wrong_price', ' '))).toBe('NOTE_REQUIRED');
      await c.supplierInvoices.returnToVendor(staff('clerk'), inv.id, 'wrong_price', 'Use the order price of 100');
      const back = await c.invoicePortal.load(s.v, inv.id);
      expect(back).toMatchObject({ state: 'returned', editable: true, number: inv.number, returnReason: { note: 'Use the order price of 100' } });
      const cleared = required(await c.supplierInvoices.get(companyId, inv.id));
      expect(cleared.lines[0]?.links).toEqual([]);
      expect(cleared.invoice).toMatchObject({ linkedBy: null, assignedTo: null });
      await c.invoicePortal.save(s.v, inv.id, { header: { ...emptyInvoiceHeader(TODAY), vendorInvoiceNo: inv.no, declaration: true }, lines: lineForms([[s.line, '10', '100']]), deliveryNotes: back.deliveryNotes.map((n) => noteForm(n.noteNo, n.fileId)), invoiceFileId: required(back.invoiceFile).id });
      const resent = await c.invoicePortal.submit(s.v, companyId, inv.id);
      expect(resent.number).toBe(inv.number);
      const now = await c.invoicePortal.load(s.v, inv.id);
      expect(now).toMatchObject({ state: 'submitted', revision: 2 });
      // A refusal is final; the number is free again.
      await c.supplierInvoices.pickUp(staff('clerk'), inv.id);
      await c.supplierInvoices.reject(staff('clerk'), inv.id, 'duplicate', '');
      expect((await c.invoicePortal.load(s.v, inv.id)).rejectReason?.label).toMatch(/already have/);
      expect(await codeOf(c.supplierInvoices.returnToVendor(staff('clerk'), inv.id, 'other', 'x'))).toBe('WRONG_STATE');
    });
  });

  describe('booking', () => {
    it('posts the invoice, the vendor’s ledger entry and the journal together, counts the goods as invoiced, and never changes again', async () => {
      const s = await setup({ discount: '0' });
      const inv = await approved(s);
      expect(await codeOf(c.invoicePosting.post(staff('finance'), inv.id))).toBe('OK');
      const row = required((await db.select().from(schema.supplierInvoices).where(eq(schema.supplierInvoices.id, inv.id)))[0]);
      expect(row).toMatchObject({ state: 'posted', total: '1160.00' });
      const pinv = required((await db.select().from(schema.purchaseInvoices).where(eq(schema.purchaseInvoices.supplierInvoiceId, inv.id)))[0]);
      expect(pinv.number).toMatch(/^PINV-\d{4}-\d{5}$/);
      const entries = await db.select().from(schema.glEntries).where(eq(schema.glEntries.registerId, pinv.registerId));
      const accounts = await db.select().from(schema.glAccounts).where(eq(schema.glAccounts.companyId, companyId));
      const no = (id: string) => accounts.find((a) => a.id === id)?.no;
      expect(entries.map((e) => [no(e.accountId), Number(e.debit), Number(e.credit)]).sort()).toEqual([['1410', 160, 0], ['2110', 0, 1160], ['2130', 1000, 0]].sort());
      const [ledger] = await db.select().from(schema.vendorLedgerEntries).where(eq(schema.vendorLedgerEntries.id, pinv.ledgerEntryId));
      expect(ledger).toMatchObject({ documentType: 'invoice', amount: '1160.00', remainingAmount: '1160.00', externalDocumentNo: inv.no });
      const [goods] = await db.select().from(schema.rgnLines).where(eq(schema.rgnLines.poLineId, s.line));
      expect(goods?.invoicedQuantity).toBe('10.000');
      const po = required(await c.purchaseOrders.get(companyId, s.order.id));
      expect(po.po.status).toBe('invoiced');
      expect(po.lines[0]?.invoicedQuantity).toBe('10.000');
      expect(await codeOf(c.invoicePosting.post(staff('finance'), inv.id))).toBe('ALREADY_POSTED');
      expect(await codeOf(db.update(schema.supplierInvoices).set({ notes: 'tamper' }).where(eq(schema.supplierInvoices.id, inv.id)))).toBe('23001');
      expect(await codeOf(db.update(schema.supplierInvoiceLines).set({ quantity: '1' }).where(eq(schema.supplierInvoiceLines.invoiceId, inv.id)))).toBe('23001');
      expect(await codeOf(db.delete(schema.purchaseInvoices).where(eq(schema.purchaseInvoices.id, pinv.id)))).toBe('23001');
      expect(await codeOf(c.supplierInvoices.returnToVendor(staff('clerk'), inv.id, 'other', 'late'))).toBe('WRONG_STATE');
      // The received goods note can no longer be reversed.
      const note = required((await db.select().from(schema.rgns).where(eq(schema.rgns.poId, s.order.id)))[0]);
      expect(await codeOf(c.rgns.reverse(staff('storeman'), note.id, 'too late'))).toBe('ALREADY_INVOICED');
      // The vendor can see the number in the ledger only once: a repeat of the vendor's own number is refused.
      const again = await setup({ discount: '0' });
      const dup = await submitted(again, inv.no);
      expect(dup.number).toMatch(/^SINV-/);
    });

    it('books a line that is not stock to the account staff chose, and needs one', async () => {
      const v = await approvedVendor();
      const order = await sentOrder(v, [{ ...emptyPoLine(), description: 'Installation labour', quantity: '3', unit: 'day', unitPrice: '5000', taxRate: '0' }], { confirm: true });
      await receive(order.id, [rl(required(order.lines[0]), '3')]);
      const s = { v, order, line: required(order.lines[0]), note: required((await c.rgns.get(companyId, required((await db.select().from(schema.rgns).where(eq(schema.rgns.poId, order.id)))[0]).id))?.rgn.deliveryNoteNo), prod: '' };
      const inv = await submitted(s, undefined, '5000');
      await c.supplierInvoices.pickUp(staff('clerk'), inv.id);
      await c.supplierInvoices.autoLink(staff('clerk'), inv.id);
      const miss = await c.supplierInvoices.runMatch(staff('clerk'), inv.id);
      expect(miss.ok).toBe(false);
      expect(required((await c.supplierInvoices.get(companyId, inv.id))?.lines[0]).match?.problems[0]).toMatch(/account/);
      const d = required(await c.supplierInvoices.get(companyId, inv.id));
      expect(await codeOf(c.supplierInvoices.saveLinks(staff('clerk'), inv.id, { links: d.lines[0]?.links.map((k) => ({ lineId: required(d.lines[0]).id, rgnLineId: k.rgnLineId, quantity: k.quantity })) ?? [], accounts: [{ lineId: required(d.lines[0]).id, glAccountId: inputTax }], notes: [] }))).toBe('INVALID');
      await c.supplierInvoices.saveLinks(staff('clerk'), inv.id, { links: d.lines[0]?.links.map((k) => ({ lineId: required(d.lines[0]).id, rgnLineId: k.rgnLineId, quantity: k.quantity })) ?? [], accounts: [{ lineId: required(d.lines[0]).id, glAccountId: expense }], notes: d.deliveryNotes.map((n) => ({ noteId: n.id, rgnId: n.matchedRgnId })) });
      expect(await c.supplierInvoices.runMatch(staff('clerk'), inv.id)).toMatchObject({ ok: true });
      await c.supplierInvoices.sendForApproval(staff('clerk'), inv.id);
      await c.supplierInvoices.approve(staff('boss'), inv.id);
      await c.invoicePosting.post(staff('finance'), inv.id);
      const pinv = required((await db.select().from(schema.purchaseInvoices).where(eq(schema.purchaseInvoices.supplierInvoiceId, inv.id)))[0]);
      const entries = await db.select().from(schema.glEntries).where(eq(schema.glEntries.registerId, pinv.registerId));
      expect(entries.map((e) => [Number(e.debit), Number(e.credit)]).sort()).toEqual([[0, 15000], [15000, 0]].sort());
    });

    it('refuses to book without a payables account, an input tax account, or in another currency', async () => {
      const s = await setup({ discount: '0' });
      const inv = await approved(s);
      await db.update(schema.vendorSettings).set({ inputTaxAccountId: null }).where(eq(schema.vendorSettings.companyId, companyId));
      expect(await codeOf(c.invoicePosting.post(staff('finance'), inv.id))).toBe('TAX_ACCOUNT_MISSING');
      await db.update(schema.vendorSettings).set({ inputTaxAccountId: inputTax }).where(eq(schema.vendorSettings.companyId, companyId));
      await db.update(schema.vendors).set({ postingGroupId: null }).where(eq(schema.vendors.id, s.v.vendorId));
      expect(await codeOf(c.invoicePosting.post(staff('finance'), inv.id))).toBe('POSTING_GROUP');
      await db.update(schema.vendors).set({ postingGroupId: await c.vendors.defaultPostingGroupId(companyId) }).where(eq(schema.vendors.id, s.v.vendorId));
      await db.update(schema.vendors).set({ block: 'all' }).where(eq(schema.vendors.id, s.v.vendorId));
      expect(await codeOf(c.invoicePosting.post(staff('finance'), inv.id))).toBe('VENDOR_BLOCKED');
      await db.update(schema.vendors).set({ block: 'none' }).where(eq(schema.vendors.id, s.v.vendorId));
      // A failed booking leaves nothing behind.
      const row = required((await db.select().from(schema.supplierInvoices).where(eq(schema.supplierInvoices.id, inv.id)))[0]);
      expect(row.state).toBe('approved');
      expect(await db.select().from(schema.purchaseInvoices).where(eq(schema.purchaseInvoices.supplierInvoiceId, inv.id))).toHaveLength(0);
      expect(await codeOf(c.invoicePosting.post(staff('finance'), inv.id))).toBe('OK');
    });
  });

  describe('the advance exception', () => {
    it('accepts an invoice with no delivery note only when the order has an approved advance, checks it against the advance, and waits for the payment slice to book it', async () => {
      const v = await approvedVendor();
      const prod = await product(0, '10');
      catSeq += 1;
      const cat = await c.categories.save(companyId, null, { ...emptyCategory(), code: `SA${String(catSeq)}_${run}`.toUpperCase(), name: `SI advance ${String(catSeq)} ${run}` });
      await c.categories.setStatus(companyId, cat.id, 'open');
      const { ids } = await c.prequal.apply(v, companyId, [cat.id], TODAY);
      await c.prequal.submit(v, required(ids[0]));
      await c.prequalReview.take(staff('evaluator'), required(ids[0]));
      await c.prequalReview.approve(staff('decider'), required(ids[0]), { maxOrderValue: '', note: '' }, TODAY);
      const { id: poId } = await c.purchaseOrders.saveDraft(staff('buyer'), null, { ...emptyPoHeader(TODAY), vendorId: v.vendorId, categoryId: cat.id, currency: 'KES', noRfqReason: 'x', requiresAdvancePayment: true }, [stockLine(prod, { discountPercent: '0', taxRate: '0' })], true);
      await c.purchaseOrders.submit(staff('buyer'), poId, NO);
      await c.purchaseOrders.approve(staff('boss'), poId);
      await c.purchaseOrders.send(staff('buyer'), poId);
      const got = required(await c.purchaseOrders.get(companyId, poId));
      const line = required(got.lines[0]).id;
      // Flagged but no advance yet: a delivery note is still needed.
      expect(await codeOf(c.invoicePortal.start(v, companyId, { poId, vendorInvoiceNo: `ADV-${run}-0` }))).toBe('NOTHING_TO_INVOICE');
      const adv = await c.advances.create(staff('buyer'), poId, { amount: '600', dueDate: '', reason: 'Deposit to start' });
      await c.advances.submit(staff('buyer'), adv.id);
      await c.advances.approve(staff('boss'), adv.id);
      const { id } = await c.invoicePortal.start(v, companyId, { poId, vendorInvoiceNo: `ADV-${run}-1` });
      const scan = await file(v);
      await c.invoicePortal.save(v, id, { header: { ...emptyInvoiceHeader(TODAY), vendorInvoiceNo: `ADV-${run}-1`, declaration: true }, lines: lineForms([[line, '10', '100']]), deliveryNotes: [], invoiceFileId: scan });
      await c.invoicePortal.submit(v, companyId, id);
      expect((await c.supplierInvoices.get(companyId, id))?.invoice.advanceBasis).toBe(true);
      await c.supplierInvoices.pickUp(staff('clerk'), id);
      expect((await c.supplierInvoices.autoLink(staff('clerk'), id)).complete).toBe(true);
      // 1,000 is more than the 600 advance approved.
      expect(await c.supplierInvoices.runMatch(staff('clerk'), id)).toMatchObject({ ok: false });
      await c.supplierInvoices.override(staff('lead'), id, 'Advance to be topped up');
      await c.supplierInvoices.sendForApproval(staff('lead'), id);
      await c.supplierInvoices.approve(staff('boss'), id);
      expect(await codeOf(c.invoicePosting.post(staff('finance'), id))).toBe('ADVANCE_INVOICE');
    });
  });

  describe('eTIMS details', () => {
    it('are asked for when the company’s rule is on and the invoice has tax, kept with the invoice, and listed when missing', async () => {
      await c.purchaseOrders.saveSettings(staff('admin'), { rfqRequiredAbove: '', amendmentTolerancePercent: '0', requireEtimsForTax: true });
      const s = await setup();
      const { id } = await c.invoicePortal.start(s.v, companyId, { poId: s.order.id, vendorInvoiceNo: `ET-${run}-${String(++seq)}` });
      const loaded = await c.invoicePortal.load(s.v, id);
      const scan = await file(s.v);
      const dnFile = await file(s.v);
      const save = async (etimsInvoiceNo: string, etimsVerificationUrl = '') => await c.invoicePortal.save(s.v, id, { header: { ...emptyInvoiceHeader(TODAY), vendorInvoiceNo: loaded.vendorInvoiceNo, declaration: true, etimsInvoiceNo, etimsVerificationUrl }, lines: lineForms([[s.line, required(loaded.lines[0]).quantity, '100']]), deliveryNotes: [noteForm(s.note, dnFile)], invoiceFileId: scan });
      await save('');
      const refused = await c.invoicePortal.submit(s.v, companyId, id).catch((e: unknown) => e as { problems?: Record<string, string> });
      expect('problems' in refused ? refused.problems?.etimsInvoiceNo : undefined).toMatch(/eTIMS invoice number/);
      expect(await codeOf(save('#', ''))).toBe('INVALID');
      expect(await codeOf(save('KRA-INV-0001', 'http://insecure.example'))).toBe('INVALID');
      await save('KRA-INV-0001', 'https://itax.kra.go.ke/KRA-Portal/invoiceChk.htm?no=1');
      const sent = await c.invoicePortal.submit(s.v, companyId, id);
      expect(sent.number).toMatch(/^SINV-/);
      const seen = required(await c.supplierInvoices.get(companyId, id));
      expect(seen.invoice).toMatchObject({ etimsInvoiceNo: 'KRA-INV-0001', etimsVerificationUrl: 'https://itax.kra.go.ke/KRA-Portal/invoiceChk.htm?no=1' });
      // With the rule off, an invoice with tax and no number goes through, and the watch list names it once booked.
      await c.purchaseOrders.saveSettings(staff('admin'), { rfqRequiredAbove: '', amendmentTolerancePercent: '0', requireEtimsForTax: false });
      const t = await setup();
      const plain = await approved(t);
      await c.invoicePosting.post(staff('finance'), plain.id);
      const watch = await c.vendorInsights.watchList(companyId, { from: '2000-01-01', to: '2999-12-31' });
      expect(watch.taxWithoutEtims.length).toBeGreaterThan(0);
      expect(watch.taxWithoutEtims.every((x) => x.taxCents > 0)).toBe(true);
    });
  });

  describe('an approval workflow (the approval engine)', () => {
    const workflowFor = async (trigger: string, vendorId: string, approverId: string) => {
      const actor = { type: 'user' as const, id: 'wf-test' };
      const reason = { code: 'POLICY_CHANGE' };
      await c.approvalConfig.saveProfile(companyId, { userId: approverId, limits: [] }, actor, reason);
      const wf = await c.approvalConfig.createWorkflow(companyId, { code: `W-${randomUUID().slice(0, 8)}`, name: 'Vendor test', trigger }, actor);
      await c.approvalConfig.saveDraft(companyId, wf.id, { conditions: { op: 'eq', field: 'vendor.id', value: vendorId }, steps: [{ sequence: 1, name: 'Boss', approver: { type: 'user', userId: approverId } }] } as never, actor);
      await c.approvalConfig.publish(companyId, wf.id, actor, reason);
    };
    const boss = async () => required((await db.insert(schema.users).values({ email: `wf-${randomUUID()}@example.test`, passwordHash: 'x', name: 'Boss', role: 'manager' }).returning())[0]).id;
    const entryOf = async (kind: string, id: string) => required((await c.approvals.forDocument(companyId, kind, id)).flatMap((r) => r.entries).find((e) => e.status === 'open'));
    const withAfterCommit = async <T,>(fn: (tx: Parameters<Parameters<DrizzleDb['transaction']>[0]>[0]) => Promise<T>): Promise<T> => await db.transaction(fn);

    it('holds a supplier invoice for the inbox: no direct approval, a release approves it, a refusal sends it back to be sent again', async () => {
      const s = await setup();
      const owner = await boss();
      const clerkId = await boss();
      await workflowFor('vendor.invoice', s.v.vendorId, owner);
      const toApproval = async () => {
        const inv = await submitted(s);
        await c.supplierInvoices.pickUp(staff('clerk'), inv.id);
        await c.supplierInvoices.autoLink(staff('clerk'), inv.id);
        await c.supplierInvoices.runMatch(staff('checker'), inv.id);
        await c.supplierInvoices.sendForApproval(staff(clerkId), inv.id);
        return inv;
      };
      const state = async (id: string) => required(await c.supplierInvoices.get(companyId, id)).invoice.state;
      const first = await toApproval();
      expect(await state(first.id)).toBe('pending_approval');
      expect(await codeOf(c.supplierInvoices.approve(staff('boss'), first.id))).toBe('USE_APPROVALS');
      await withAfterCommit(async (tx) => await c.approvals.reject((await entryOf('vendor_invoice', first.id)).id, owner, { reasonCode: 'OTHER', comment: 'Price looks high' }, tx));
      expect(await state(first.id)).toBe('matched');
      await c.supplierInvoices.sendForApproval(staff(clerkId), first.id);
      expect(await state(first.id)).toBe('pending_approval');
      await withAfterCommit(async (tx) => await c.approvals.approve((await entryOf('vendor_invoice', first.id)).id, owner, null, tx));
      expect(await state(first.id)).toBe('approved');
      const row = required(await c.supplierInvoices.get(companyId, first.id)).invoice;
      expect(row.approvedBy).toBe(owner);
    });

    it('does the same for a purchase order: held for the inbox, released by it', async () => {
      const v = await approvedVendor();
      const owner = await boss();
      const buyerId = await boss();
      await workflowFor('po.release', v.vendorId, owner);
      catSeq += 1;
      const cat = await c.categories.save(companyId, null, { ...emptyCategory(), code: `WF${String(catSeq)}_${run}`.toUpperCase(), name: `WF category ${String(catSeq)} ${run}` });
      await c.categories.setStatus(companyId, cat.id, 'open');
      const { ids } = await c.prequal.apply(v, companyId, [cat.id], TODAY);
      await c.prequal.submit(v, required(ids[0]));
      await c.prequalReview.take(staff('evaluator'), required(ids[0]));
      await c.prequalReview.approve(staff('decider'), required(ids[0]), { maxOrderValue: '', note: '' }, TODAY);
      const prod = await product(0, '10');
      const { id } = await c.purchaseOrders.saveDraft(staff(buyerId), null, { ...emptyPoHeader(TODAY), vendorId: v.vendorId, categoryId: cat.id, currency: 'KES', noRfqReason: 'Test' }, [stockLine(prod, { unitPrice: '50' })], false);
      await c.purchaseOrders.submit(staff(buyerId), id, NO);
      expect(await codeOf(c.purchaseOrders.approve(staff('boss'), id))).toBe('USE_APPROVALS');
      expect(await codeOf(c.purchaseOrders.reject(staff('boss'), id, 'No'))).toBe('USE_APPROVALS');
      await withAfterCommit(async (tx) => await c.approvals.approve((await entryOf('vendor_po', id)).id, owner, null, tx));
      expect(required(await c.purchaseOrders.get(companyId, id)).po.status).toBe('approved');
    });
  });
});
