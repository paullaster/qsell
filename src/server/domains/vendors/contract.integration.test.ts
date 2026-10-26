import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { has, isRecord, readText, required } from '@/lib/values';
import { emptyBusiness, emptyFinancial, emptyProfile, type ProfileData } from '@/lib/vendor-profile';
import { emptyCategory } from '@/lib/prequalification';
import { emptyPoHeader, emptyPoLine, type PoLineForm } from '@/lib/purchase-order';
import { emptyContractLine, type ContractHeaderForm, type ContractLineForm } from '@/lib/vendor-contract';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import type * as mod_schema from '@/server/db/drizzle/schema';
import type { AppContainer } from '@/server/di/container';
import type { FinanceContext } from '@/server/domains/finance/errors';
import type { PortalActor } from './profile-service';

/** Needs a Postgres built from the migrations:  TEST_DATABASE_URL=postgres://... pnpm test */
const url = process.env.TEST_DATABASE_URL;

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

describe.skipIf(!has(url))('vendor contracts (database)', () => {
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
    const [u] = await db.insert(schema.users).values({ email: `ct${String(seq)}.${run}@example.test`, passwordHash: 'x', name: 'Owner', role: 'vendor' }).returning();
    const vendorId = await c.vendors.registerBusiness({ companyId, userId: required(u).id, legalName: `CT Vendor ${run} ${String(seq)}`, email: `ct${String(seq)}.${run}@example.test`, phone: null });
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
    const itemTypeId = `itc_${run}_${String(prodSeq)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({ id, sku: `CT-${run}-${String(prodSeq)}`.toUpperCase(), stockCode: `CTS-${run}-${String(prodSeq)}`.toUpperCase(), name: `Receiving ${String(prodSeq)}`, slug: `ct-${randomUUID()}`, itemTypeId, price: '999', costPrice: cost, stockQuantity: stock });
    return id;
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
      .values({ legalName: 'CT', tradingName: 'CT', email: 'buyer@ct.test', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P' })
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


  const today = new Date().toISOString().slice(0, 10);
  const nextYear = `${String(Number(today.slice(0, 4)) + 1)}${today.slice(4)}`;
  async function category() {
    catSeq += 1;
    const cat = await c.categories.save(companyId, null, { ...emptyCategory(), code: `CT${String(catSeq)}_${run}`.toUpperCase(), name: `Contract category ${String(catSeq)} ${run}` });
    await c.categories.setStatus(companyId, cat.id, 'open');
    return cat.id;
  }
  const cHeader = (vendorId: string, categoryId: string, over: Partial<ContractHeaderForm> = {}): ContractHeaderForm => ({ vendorId, categoryId, title: 'Panels 2027', currency: 'KES', validFrom: today, validTo: nextYear, maxValue: '', terms: '', ...over });
  const cLine = (over: Partial<ContractLineForm> = {}): ContractLineForm => ({ ...emptyContractLine(), description: 'Solar panel 450W', unit: unit.code, unitPrice: '100', taxRate: '16', maxQuantity: '100', ...over });
  async function active(over: Partial<ContractHeaderForm> = {}, lines: ContractLineForm[] = [cLine()]) {
    const v = await approvedVendor();
    const cat = await category();
    const { id } = await c.contracts.saveDraft(staff('buyer'), null, cHeader(v.vendorId, cat, over), lines);
    await c.contracts.submit(staff('buyer'), id);
    await c.contracts.approve(staff('boss'), id);
    const got = required(await c.contracts.get(companyId, id));
    return { v, cat, id, lines: got.lines.map((l) => l.id), number: required(got.contract.number) };
  }
  const callOff = async (id: string, lineId: string, quantity: string) => await c.purchaseOrders.createFromContract(staff('buyer'), id, [{ contractLineId: lineId, quantity }], { expectedDate: '', notes: '' });

  it('is written, approved by another person, numbered, and then cannot be changed', async () => {
    const v = await approvedVendor();
    const cat = await category();
    expect(await codeOf(c.contracts.saveDraft(staff('buyer'), null, cHeader(v.vendorId, cat, { validTo: '2000-01-01' }), [cLine()]))).toBe('INVALID');
    expect(await codeOf(c.contracts.saveDraft(staff('buyer'), null, cHeader(v.vendorId, cat), []))).toBe('INVALID');
    const { id } = await c.contracts.saveDraft(staff('buyer'), null, cHeader(v.vendorId, cat), [cLine()]);
    expect(await codeOf(c.contracts.submit(staff('other'), id))).toBe('NOT_YOURS');
    await c.contracts.submit(staff('buyer'), id);
    expect(await codeOf(c.contracts.approve(staff('buyer'), id))).toBe('FOUR_EYES');
    const out = await c.contracts.approve(staff('boss'), id);
    expect(out.number).toMatch(/^CTR-\d{4}-\d{5}$/);
    expect(await codeOf(c.contracts.saveDraft(staff('buyer'), id, cHeader(v.vendorId, cat), [cLine()]))).toBe('NOT_DRAFT');
    expect(await codeOf(db.update(schema.vendorContracts).set({ validTo: '2999-01-01' }).where(eq(schema.vendorContracts.id, id)))).toBe('23001');
    expect(await codeOf(db.update(schema.vendorContractLines).set({ unitPrice: '1.00' }).where(eq(schema.vendorContractLines.contractId, id)))).toBe('23001');
    expect(await codeOf(db.delete(schema.vendorContracts).where(eq(schema.vendorContracts.id, id)))).toBe('23001');
    expect(await codeOf(c.contracts.cancel(staff('buyer'), id, 'No'))).toBe('WRONG_STATE');
  });

  it('is called off at its own prices, refuses more than a line or the ceiling allows, and a cancelled order gives its quantity back', async () => {
    const k = await active({ maxValue: '12000' }, [cLine({ maxQuantity: '100' }), cLine({ description: 'Inverter', unitPrice: '500', maxQuantity: '' })]);
    const [panel, inverter] = k.lines;
    const first = await callOff(k.id, required(panel), '60');
    const po = required(await c.purchaseOrders.get(companyId, first.id));
    expect(po.po).toMatchObject({ status: 'draft', vendorId: k.v.vendorId, contractId: k.id, total: '6960.00', currency: 'KES' });
    expect(po.lines[0]).toMatchObject({ unitPrice: '100.00', quantity: '60.000' });
    expect(await codeOf(callOff(k.id, required(panel), '40.001'))).toBe('OVER_CONTRACT');
    // 60 + 40 panels fit the line (100), but 6960 + 4640 = 11600 and one inverter more would pass 12000.
    const second = await callOff(k.id, required(panel), '40');
    expect(await codeOf(callOff(k.id, required(inverter), '1'))).toBe('OVER_CONTRACT');
    const detail = required(await c.contracts.get(companyId, k.id));
    expect(detail.lines[0]).toMatchObject({ usedQuantity: 100, remaining: 0 });
    expect(detail).toMatchObject({ usedValue: '11600.00', leftValue: '400.00' });
    await c.purchaseOrders.cancel(staff('buyer'), second.id, 'Ordered by mistake');
    expect(required(await c.contracts.get(companyId, k.id)).lines[0]).toMatchObject({ usedQuantity: 60, remaining: 40 });
    expect((await callOff(k.id, required(inverter), '1')).id).toBeDefined();
    // The order is the contract's: it cannot be edited as a free draft.
    expect(await codeOf(c.purchaseOrders.saveDraft(staff('buyer'), first.id, { ...emptyPoHeader(today), vendorId: k.v.vendorId, categoryId: k.cat, currency: 'KES', noRfqReason: 'Because' }, [{ ...emptyPoLine(), description: 'Solar panel', unit: 'each', unitPrice: '1' }], false))).toBe('FROM_CONTRACT');
    expect(await codeOf(c.purchaseOrders.createFromContract(staff('buyer'), k.id, [], { expectedDate: '', notes: '' }))).toBe('OVER_CONTRACT');
    expect(await codeOf(c.purchaseOrders.createFromContract(staff('buyer'), randomUUID(), [{ contractLineId: required(panel), quantity: '1' }], { expectedDate: '', notes: '' }))).toBe('NOT_FOUND');
  });

  it('refuses call-offs once it is closed, before it starts and after it ends, and keeps an order’s prices when it is amended', async () => {
    const future = await active({ validFrom: nextYear, validTo: `${String(Number(nextYear.slice(0, 4)) + 1)}${nextYear.slice(4)}` });
    expect(await codeOf(callOff(future.id, required(future.lines[0]), '1'))).toBe('OVER_CONTRACT');
    const k = await active({}, [cLine({ maxQuantity: '50' })]);
    const order = await callOff(k.id, required(k.lines[0]), '10');
    const { id: orderId } = order;
    // Qualify the vendor in the category, then take the order through to released.
    const { ids } = await c.prequal.apply(k.v, companyId, [k.cat], today);
    await c.prequal.submit(k.v, required(ids[0]));
    await c.prequalReview.take(staff('evaluator'), required(ids[0]));
    await c.prequalReview.approve(staff('decider'), required(ids[0]), { maxOrderValue: '', note: '' }, today);
    await c.purchaseOrders.submit(staff('buyer'), orderId, { maySkipRfq: false, mayOverrideQualification: false });
    await c.purchaseOrders.approve(staff('boss'), orderId);
    await c.purchaseOrders.send(staff('buyer'), orderId);
    const got = required(await c.purchaseOrders.get(companyId, orderId));
    const line = required(got.lines[0]);
    const input = (over: Partial<PoLineForm> = {}) => ({ header: { expectedDate: '', paymentTerms: '', deliveryTerms: '', notesToVendor: '', requiresAdvancePayment: false }, lines: [{ id: line.id, productId: '', description: line.description, specification: '', quantity: '12', unit: line.unit, unitPrice: line.unitPrice, discountPercent: line.discountPercent, taxRate: line.taxRate, expectedDate: '', ...over }], reason: 'Two more needed' });
    expect(await codeOf(c.purchaseOrders.amend(staff('buyer'), orderId, input({ unitPrice: '90' }), false))).toBe('FROM_CONTRACT');
    expect(await codeOf(c.purchaseOrders.amend(staff('buyer'), orderId, input({ quantity: '51' }), false))).toBe('OVER_CONTRACT');
    expect(await codeOf(c.purchaseOrders.amend(staff('buyer'), orderId, { ...input(), lines: [...input().lines, { ...input().lines[0], id: undefined, description: 'Extra' }] }, false))).toBe('FROM_CONTRACT');
    await c.purchaseOrders.saveSettings(staff('admin'), { rfqRequiredAbove: '', amendmentTolerancePercent: '50' });
    const amended = await c.purchaseOrders.amend(staff('buyer'), orderId, input(), false);
    expect(amended.applied).toBe(true);
    await c.purchaseOrders.saveSettings(staff('admin'), { rfqRequiredAbove: '', amendmentTolerancePercent: '0' });
    expect(required(await c.contracts.get(companyId, k.id)).lines[0]?.usedQuantity).toBe(12);
    await c.contracts.close(staff('boss'), k.id, 'Vendor changed its prices');
    expect(await codeOf(callOff(k.id, required(k.lines[0]), '1'))).toBe('OVER_CONTRACT');
    expect((await c.contracts.list(companyId, { status: 'closed' })).some((x) => x.id === k.id)).toBe(true);
  });
});
