import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { has, isRecord, readText, required } from '@/lib/values';
import { emptyBusiness, emptyFinancial, emptyProfile, type ProfileData } from '@/lib/vendor-profile';
import { emptyCategory } from '@/lib/prequalification';
import { emptyPoHeader, emptyPoLine, type PoLineForm } from '@/lib/purchase-order';
import type { RgnHeaderForm, RgnLineForm } from '@/lib/rgn';
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

describe.skipIf(!has(url))('UBL documents (database)', () => {
  let db: DrizzleDb;
  let schema: typeof mod_schema;
  let c: AppContainer;
  let companyId: string;
  let unit: { code: string; name: string };
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
    const [u] = await db.insert(schema.users).values({ email: `ub${String(seq)}.${run}@example.test`, passwordHash: 'x', name: 'Owner', role: 'vendor' }).returning();
    const vendorId = await c.vendors.registerBusiness({ companyId, userId: required(u).id, legalName: `UB Vendor ${run} ${String(seq)}`, email: `ub${String(seq)}.${run}@example.test`, phone: null });
    const a: PortalActor = { vendorId, userId: required(u).id, portalRole: 'owner' };
    const p = c.vendorProfile;
    const profile: ProfileData = { ...emptyProfile(), country: 'Kenya', description: 'We supply solar panels and inverters to businesses.', physicalStreet: '1 Mombasa Road', physicalCity: 'Nairobi', phone: '+254 700 000 000' };
    await p.saveProfile(a, profile);
    await p.saveBusiness(a, { ...emptyBusiness(), registrationNo: 'CPR/2012/12345', registrationDate: '2012-03-04', taxId: `G${String(Date.now()).slice(-9)}${String(seq % 10)}` });
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

  async function product(stock: number, cost: string): Promise<string> {
    prodSeq += 1;
    const itemTypeId = `itu_${run}_${String(prodSeq)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({ id, sku: `UB-${run}-${String(prodSeq)}`.toUpperCase(), stockCode: `UBS-${run}-${String(prodSeq)}`.toUpperCase(), name: `Receiving ${String(prodSeq)}`, slug: `ub-${randomUUID()}`, itemTypeId, price: '999', costPrice: cost, stockQuantity: stock });
    return id;
  }

  /** A sent order with the lines given, for a qualified vendor; returns the order and its line ids. */
  async function sentOrder(v: PortalActor, lines: PoLineForm[], over: { currency?: string; confirm?: boolean } = {}) {
    catSeq += 1;
    const cat = await c.categories.save(companyId, null, { ...emptyCategory(), code: `UB${String(catSeq)}_${run}`.toUpperCase(), name: `UB category ${String(catSeq)} ${run}` });
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
  const dn = () => `DN-UB-${run}-${String(++seq)}`;
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
      .values({ legalName: 'UB', tradingName: 'UB', email: 'buyer@ub.test', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P' })
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




  const ubl = (orderNumber: string, lines: string, over: { id?: string; currency?: string; date?: string } = {}) => `<?xml version="1.0"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"><cbc:ID>${over.id ?? `UB-${run}-${String(++seq)}`}</cbc:ID><cbc:IssueDate>${over.date ?? TODAY}</cbc:IssueDate><cbc:DocumentCurrencyCode>${over.currency ?? 'KES'}</cbc:DocumentCurrencyCode><cac:OrderReference><cbc:ID>${orderNumber}</cbc:ID></cac:OrderReference>${lines}</Invoice>`;
  const ublLine = (orderLine: string, quantity: string, price: string, description = 'Solar panel 450W') => `<cac:InvoiceLine><cbc:ID>1</cbc:ID><cbc:InvoicedQuantity unitCode="C62">${quantity}</cbc:InvoicedQuantity><cac:OrderLineReference><cbc:LineID>${orderLine}</cbc:LineID></cac:OrderLineReference><cac:Item><cbc:Description>${description}</cbc:Description></cac:Item><cac:Price><cbc:PriceAmount currencyID="KES">${price}</cbc:PriceAmount></cac:Price></cac:InvoiceLine>`;
  async function ordered(receiveAll = true) {
    const v = await approvedVendor();
    const prod = await product(0, '10');
    const order = await sentOrder(v, [stockLine(prod, { quantity: '10', discountPercent: '0' })]);
    if (receiveAll) await receive(order.id, [rl(required(order.lines[0]), '10')]);
    return { v, order };
  }

  it('writes an approved order as UBL for its own vendor only, and not before it is approved', async () => {
    const { v, order } = await ordered(false);
    const mine = await c.edi.orderXml(companyId, order.id, v.vendorId);
    expect(mine.fileName).toBe(`${order.number}.xml`);
    expect(mine.xml).toContain(`<cbc:ID>${order.number}</cbc:ID>`);
    expect(mine.xml).toContain('<cbc:PayableAmount currencyID="KES">1160.00</cbc:PayableAmount>');
    const other = await approvedVendor();
    expect(await codeOf(c.edi.orderXml(companyId, order.id, other.vendorId))).toBe('NOT_FOUND');
    expect((await c.edi.orderXml(companyId, order.id)).xml).toContain('Order');
    const draft = await c.purchaseOrders.saveDraft(staff('buyer'), null, { ...emptyPoHeader(TODAY), vendorId: v.vendorId, categoryId: required(await c.purchaseOrders.get(companyId, order.id)).po.categoryId, currency: 'KES', noRfqReason: 'Test' }, [stockLine(await product(0, '1'))], false);
    expect(await codeOf(c.edi.orderXml(companyId, draft.id))).toBe('NOT_FOUND');
  });

  it('starts an invoice draft from a UBL invoice with its quantities and prices, lists what it left out, and refuses what is not the vendor’s', async () => {
    const { v, order } = await ordered();
    const orderNumber = order.number;
    const out = await c.edi.startInvoice(v, companyId, ubl(orderNumber, ublLine('1', '4', '100') + ublLine('9', '1', '5', 'Mystery')));
    expect(out.warnings.join(' ')).toMatch(/Mystery/);
    const draft = required(await c.invoicePortal.load(v, out.id));
    expect(draft).toMatchObject({ state: 'draft', orderNumber, currency: 'KES', declaration: false });
    expect(draft.lines).toHaveLength(1);
    expect(draft.lines[0]).toMatchObject({ quantity: '4.000', unitPrice: '100.00' });
    // The same invoice number is refused, a wrong order number or another vendor's order is "not found", and a bad file says why.
    const again = ubl(orderNumber, ublLine('1', '1', '100'), { id: draft.vendorInvoiceNo });
    expect(await codeOf(c.edi.startInvoice(v, companyId, again))).toBe('DUPLICATE');
    expect(await codeOf(c.edi.startInvoice(v, companyId, ubl('PO-NOPE', ublLine('1', '1', '100'))))).toBe('NOT_FOUND');
    const stranger = await approvedVendor();
    expect(await codeOf(c.edi.startInvoice(stranger, companyId, ubl(orderNumber, ublLine('1', '1', '100'))))).toBe('NOT_FOUND');
    expect(await codeOf(c.edi.startInvoice(v, companyId, ubl(orderNumber, ublLine('1', '1', '100'), { currency: 'USD' })))).toBe('INVALID');
    expect(await codeOf(c.edi.startInvoice(v, companyId, ubl(orderNumber, ublLine('1', '1', '100'), { date: '2999-01-01' })))).toBe('INVALID');
    expect(await codeOf(c.edi.startInvoice(v, companyId, ubl(orderNumber, ublLine('7', '1', '100', 'Nothing here'))))).toBe('INVALID');
    expect(await codeOf(c.edi.startInvoice(v, companyId, '<!DOCTYPE x><Invoice/>'))).toBe('INVALID');
  });

  it('refuses an invoice for an order whose goods have not arrived', async () => {
    const { v, order } = await ordered(false);
    expect(await codeOf(c.edi.startInvoice(v, companyId, ubl(order.number, ublLine('1', '1', '100'))))).toBe('NOTHING_TO_INVOICE');
  });
});
