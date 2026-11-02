import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray, like } from 'drizzle-orm';
import { has } from '@/lib/values';
import type * as mod_server_di_container from '@/server/di/container';
import type * as mod_server_db_drizzle_client from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';
import type * as BillingActions from './billing-actions';
import type { OrderWriteService as OrderWriteServiceType } from '@/server/domains/orders/write-service';
import type * as SigningModule from '@/server/domains/kra/signing/service';
import type { SignableInvoice } from '@/server/domains/kra/signing/service';
import { settleFinanceBacklog } from '@/server/domains/stock/test-support';

const { requirePermission } = vi.hoisted(() => ({ requirePermission: vi.fn() }));
vi.mock('@/server/domains/access-control/guard', async (original) => ({ ...(await original<Record<string, unknown>>()), requirePermission }));
vi.mock('@/server/domains/finance/action-runner', () => ({ injectedDelay: () => Promise.resolve() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Headers({ 'x-real-ip': '10.1.2.4' })) }));
vi.mock('@/auth', () => ({ auth: () => Promise.resolve(null) }));

/**
 * How delivery is billed, against a real database: the company's choice (delivery on the goods invoice, or on its own), the
 * invoices and their emails and PDFs laid out from one plan, the delivery service's own invoice and its number, and what is sent
 * to KRA for each, with the tax in its parts and the refusals that keep a wrong tax from being signed.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

const CUSTOMER = { latitude: -1.2921, longitude: 36.8219 };
const NAIROBI = { latitude: -1.2864, longitude: 36.8172 };

describe.skipIf(!has(url))('delivery billing (database)', () => {
  let db: typeof mod_server_db_drizzle_client.drizzleDb;
  let schema: typeof mod_server_db_drizzle_schema;
  let c: ReturnType<typeof mod_server_di_container.getContainer>;
  let actions: typeof BillingActions;
  let createOrder: (typeof OrderWriteServiceType)['createOrder'];
  let SigningService: typeof SigningModule.DocumentSigningService;
  let companyId: string;
  let itemTypeId: string;
  let spy: { mockRestore: () => void } | undefined;
  const tag = randomUUID().slice(0, 6).toUpperCase();
  let n = 0;
  const code = () => `DB${tag}${String((n += 1)).padStart(3, '0')}`;
  const madeBranches: string[] = [];
  const madeLocations: string[] = [];

  const setMode = async (mode: 'with_goods' | 'separate', serviceProductId: string | null) => {
    const v = (await c.deliveryBilling.get(companyId)).version;
    const r = await actions.saveDeliveryBillingAction({ mode, serviceProductId, expectedVersion: v, reason: 'Set up for the test' });
    if (!r.ok) throw new Error(r.error);
  };
  const product = async (over: { tax?: string | null; name?: string } = {}) => {
    const id = `prod_db_${randomUUID()}`;
    await db.insert(schema.products).values({ id, sku: `DB-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `DBS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: over.name ?? `Billed ${id.slice(-6)}`, slug: `db-${randomUUID()}`, itemTypeId, price: '1000', costPrice: '10', taxRate: over.tax === undefined ? '16' : over.tax, isTaxInclusive: false, stockQuantity: 0 });
    return id;
  };
  /** A delivered order: one product of 1,000 before tax with 16% tax, delivery 300 before tax with 16% tax (so 348 to pay). */
  const delivered = async (deliveryTax = 16) => {
    const [b] = await db.insert(schema.branches).values({ companyId, code: code(), name: `Branch ${code()}`, latitude: NAIROBI.latitude, longitude: NAIROBI.longitude }).returning();
    const branchId = b?.id ?? '';
    madeBranches.push(branchId);
    await db.insert(schema.deliveryMethods).values({ companyId, branchId, method: 'own_fleet' });
    const p = await product();
    const loc = await c.stockLocations.create(companyId, { code: code(), name: 'Shelf', kind: 'store', branchId, fulfilsDelivery: true });
    madeLocations.push(loc.id);
    await db.transaction((tx) => c.stockLedger.post(tx, { companyId, productId: p, locationId: loc.id, type: 'receipt', quantity: 10, unitCost: 10, actor: { type: 'job' } }));
    const policies = await import('./policy-actions');
    const made = await policies.createChargePolicyDraftAction(code(), { name: 'Flat', method: 'flat', currency: 'KES', scopes: { branch: { op: 'in', values: [branchId] } }, rates: [{ zoneId: null, fromKg: 0, toKg: null, fee: 300 }], taxRate: deliveryTax });
    if (!made.ok) throw new Error(made.error);
    const live = await policies.activateChargePolicyAction(made.data.id, 'Set up for the test');
    if (!live.ok) throw new Error(live.error);
    const r = await createOrder({
      orderNumber: `DB-${randomUUID()}`, customerName: 'Billing Buyer', customerEmail: `db-${randomUUID()}@bill.test`, customerPhone: '0700000000',
      shippingAddress: { street: '1 Test Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' },
      items: [{ productId: p, quantity: 1 }], currency: 'KES', paymentMethod: 'mpesa_daraja',
      delivery: { method: 'own_fleet', pin: CUSTOMER },
    });
    if (!r.success || r.order === undefined) throw new Error(r.error);
    return { order: r.order, productId: p, branchId };
  };

  /** The signing service with a pretend KRA: it says "sign" and keeps what it was asked to send. */
  const signer = () => {
    const sent: { number: string; total: number; lines: SignableInvoice['lines'] }[] = [];
    const policy = { decide: () => Promise.resolve({ outcome: 'sign', reason: 'SIGN', scope: 'company', branchId: null, mode: 'etims', gates: [], settings: {} }) };
    const items = { requireItemCodesForInvoice: (i: { productIds: string[] }) => Promise.resolve(new Map(i.productIds.map((id) => [id, `KRA-${id}`]))) };
    const transmissions = {
      transmitInvoice: (i: { traderInvoiceNo: string; totalAmount: number; lines: { itemCode: string; qty: number; unitPrice: number; amount: number }[] }) => {
        sent.push({ number: i.traderInvoiceNo, total: i.totalAmount, lines: i.lines.map((l) => ({ productId: l.itemCode.replace('KRA-', ''), qty: l.qty, unitPrice: l.unitPrice, amount: l.amount })) });
        return Promise.resolve({ id: null, scuReceiptNo: '1', verificationUrl: null, attempts: 1 });
      },
    };
    const service = new SigningService(db, policy as never, items as never, transmissions as never);
    return { service, sent };
  };

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    actions = await import('./billing-actions');
    ({ DocumentSigningService: SigningService } = await import('@/server/domains/kra/signing/service'));
    const writer = (await import('@/server/domains/orders/write-service')).OrderWriteService;
    createOrder = (input) => writer.createOrder(input);
    c = mod.getContainer();
    const ours = await c.companySettings.ensureSeeded();
    companyId = ours.id;
    spy = vi.spyOn(c.companySettings, 'ensureSeeded').mockResolvedValue(ours);
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Billing Test Co');
    itemTypeId = `it_db_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    await c.stockLocations.ensureDefault(companyId);
    await c.stockShadow.setShadow(companyId, false);
    await c.stockSettings.setLedgerMode(companyId, true, { requireCleanShadow: false });
    await db.delete(schema.deliveryBillingSettings).where(eq(schema.deliveryBillingSettings.companyId, companyId));
  }, 180_000);
  afterAll(async () => {
    spy?.mockRestore();
    await c.stockSettings.setLedgerMode(companyId, false);
    await db.delete(schema.deliveryBillingSettings).where(eq(schema.deliveryBillingSettings.companyId, companyId));
    const rest = await db.select({ id: schema.chargePolicies.id }).from(schema.chargePolicies).where(like(schema.chargePolicies.code, `DB${tag}%`));
    if (rest.length > 0) {
      await db.delete(schema.chargePolicyRates).where(inArray(schema.chargePolicyRates.policyId, rest.map((r) => r.id)));
      await db.delete(schema.chargePolicies).where(inArray(schema.chargePolicies.id, rest.map((r) => r.id)));
    }
    await settleFinanceBacklog(c.finance);
  }, 120_000);
  beforeEach(() => {
    requirePermission.mockReset().mockResolvedValue('user-1');
  });
  afterEach(async () => {
    if (madeBranches.length > 0) await db.update(schema.branches).set({ isActive: false }).where(inArray(schema.branches.id, madeBranches));
    if (madeLocations.length > 0) await db.update(schema.stockLocations).set({ isActive: false }).where(inArray(schema.stockLocations.id, madeLocations));
  });

  describe('the setting', () => {
    it('is delivery on the goods invoice, with no item chosen, until someone chooses', async () => {
      expect(await c.deliveryBilling.forInvoicing(companyId)).toEqual({ mode: 'with_goods', serviceProductId: null });
      expect(await c.deliveryBilling.get(companyId)).toMatchObject({ mode: 'with_goods', serviceItem: null, version: 0, taxMismatches: [] });
    });

    it('saves a mode and the delivery service item with a reason, shows the item’s tax, and logs the change', async () => {
      const p = await product({ name: 'Delivery service' });
      const r = await actions.saveDeliveryBillingAction({ mode: 'separate', serviceProductId: p, expectedVersion: 0, reason: 'Our accountant wants it apart' });
      expect(r).toMatchObject({ ok: true, data: { mode: 'separate', serviceItem: { id: p, name: 'Delivery service', taxRate: 16, registered: false }, version: 1 } });
      expect(await c.deliveryBilling.forInvoicing(companyId)).toEqual({ mode: 'separate', serviceProductId: p });
      const log = await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectId, companyId));
      expect(log.find((l) => l.action === 'delivery.billing_changed')).toMatchObject({ fromState: 'with_goods', toState: 'separate', reasonText: 'Our accountant wants it apart' });
    });

    it('refuses without a reason, a mode that does not exist, an item that does not exist, or a stale version', async () => {
      const v = (await c.deliveryBilling.get(companyId)).version;
      const p = await product();
      expect(await actions.saveDeliveryBillingAction({ mode: 'with_goods', serviceProductId: p, expectedVersion: v, reason: 'no' })).toMatchObject({ ok: false, error: expect.stringContaining('Say why') as string });
      expect(await actions.saveDeliveryBillingAction({ mode: 'both', serviceProductId: p, expectedVersion: v, reason: 'Some reason' })).toMatchObject({ ok: false });
      expect(await actions.saveDeliveryBillingAction({ mode: 'with_goods', serviceProductId: 'prod_missing', expectedVersion: v, reason: 'Some reason' })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
      expect(await actions.saveDeliveryBillingAction({ mode: 'with_goods', serviceProductId: p, expectedVersion: v - 1, reason: 'Some reason' })).toMatchObject({ ok: false, code: 'CONFLICT' });
      expect((await c.deliveryBilling.get(companyId)).version).toBe(v);
    });

    it('lets only one of two people saving from the same version win', async () => {
      const v = (await c.deliveryBilling.get(companyId)).version;
      const p = await product();
      const [a, b] = await Promise.all([
        actions.saveDeliveryBillingAction({ mode: 'with_goods', serviceProductId: p, expectedVersion: v, reason: 'First person' }),
        actions.saveDeliveryBillingAction({ mode: 'separate', serviceProductId: p, expectedVersion: v, reason: 'Second person' }),
      ]);
      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    });

    it('names a charge policy in force whose tax is not the item’s, so the difference is seen before an invoice is refused', async () => {
      const zero = await product({ tax: '0' });
      await setMode('with_goods', zero);
      await delivered(16);
      const view = await c.deliveryBilling.get(companyId);
      expect(view.taxMismatches.length).toBeGreaterThan(0);
      expect(view.taxMismatches.every((m) => m.taxRate === 16)).toBe(true);
    });

    it('is seen with deliveries:read and changed only with deliveries:manage', async () => {
      requirePermission.mockClear();
      await actions.deliveryBillingPageAction();
      await actions.saveDeliveryBillingAction({ mode: 'with_goods', serviceProductId: null, expectedVersion: 0, reason: 'x' });
      expect(requirePermission.mock.calls.map((call: unknown[]) => call.at(0))).toEqual(['deliveries:read', 'deliveries:manage']);
      const before = await c.deliveryBilling.get(companyId);
      requirePermission.mockRejectedValue(new Error('Forbidden'));
      expect((await actions.saveDeliveryBillingAction({ mode: 'separate', serviceProductId: null, expectedVersion: before.version, reason: 'Forbidden' })).ok).toBe(false);
      expect((await actions.deliveryBillingPageAction()).ok).toBe(false);
      expect(await c.deliveryBilling.get(companyId)).toEqual(before);
    });
  });

  describe('on the same invoice', () => {
    it('signs one invoice: the products and, beside them, the delivery service item at what the customer pays, the total being the order’s', async () => {
      const service = await product({ name: 'Delivery service' });
      await setMode('with_goods', service);
      const { order, productId } = await delivered();
      const { service: signing, sent } = signer();
      const result = await signing.processOrderDocument({ orderId: order.id, documentType: 'tax_invoice', invoiceNumber: `INV-${tag}-1` });
      expect(result.outcome).toBe('sign');
      expect(sent).toHaveLength(1);
      expect(sent[0]?.total).toBe(order.totalAmount);
      expect(sent[0]?.lines.map((l) => l.productId)).toEqual([productId, service]);
      expect(sent[0]?.lines[1]).toMatchObject({ qty: 1, unitPrice: 348, amount: 348 });
    });

    it('lays the invoice out with delivery as a line and the tax for the products, for the delivery and in all', async () => {
      const service = await product();
      await setMode('with_goods', service);
      const { order } = await delivered();
      const { plan, figures } = await c.invoices.planFor(order, 'tax_invoice');
      expect(plan.deliveryInvoice).toBeNull();
      expect(figures.deliveryLine).toMatchObject({ net: 300, tax: 48, gross: 348, taxRate: 16 });
      expect(figures.taxRows.map((r) => r.label)).toEqual(['VAT on products', 'VAT on delivery (16%)', 'Total VAT']);
      expect(figures.taxRows.map((r) => r.amount)).toEqual([order.tax - 48, 48, order.tax]);
      expect(figures.totalAmount).toBe(order.totalAmount);
    });

    it('records the invoice with the delivery inside it, and puts the delivery line and the tax parts on the document', async () => {
      const service = await product();
      await setMode('with_goods', service);
      const { order } = await delivered();
      const generate = vi.fn((_payload: { items: { sku: string; totalPrice: number }[]; taxRows?: { label: string }[]; totalAmount: number; shippingFee: number }) => Promise.resolve(Buffer.from('pdf')));
      const pdf = (c.invoices as unknown as { deps: { invoicePdf: { generate: unknown } } }).deps.invoicePdf;
      const original = pdf.generate;
      pdf.generate = generate;
      try {
        const made = await c.invoices.generatePdf(order.id, 'tax_invoice');
        const payload = generate.mock.calls[0]?.[0];
        expect(payload?.items.map((i) => i.sku)).toContain('DELIVERY');
        expect(payload?.items.find((i) => i.sku === 'DELIVERY')?.totalPrice).toBe(300);
        expect(payload?.taxRows?.map((r) => r.label)).toEqual(['VAT on products', 'VAT on delivery (16%)', 'Total VAT']);
        expect(payload?.shippingFee).toBe(0);
        expect(payload?.totalAmount).toBe(order.totalAmount);
        const rows = await db.select().from(schema.invoiceDocuments).where(eq(schema.invoiceDocuments.orderId, order.id));
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ invoiceNumber: made.invoiceNumber, documentType: 'tax_invoice' });
        expect(Number(rows[0]?.totalAmount)).toBe(order.totalAmount);
      } finally {
        pdf.generate = original;
      }
    });

    it('refuses to sign, in words, when no item stands for the delivery service, and sends nothing', async () => {
      await setMode('with_goods', null);
      const { order } = await delivered();
      const { service: signing, sent } = signer();
      const result = await signing.processOrderDocument({ orderId: order.id, documentType: 'tax_invoice', invoiceNumber: `INV-${tag}-2` });
      expect(result).toMatchObject({ outcome: 'fail', reason: 'DELIVERY_ITEM_NOT_SET' });
      expect(sent).toHaveLength(0);
      const events = await db.select().from(schema.kraSigningEvents).where(eq(schema.kraSigningEvents.documentId, order.id));
      expect(JSON.stringify(events.map((e) => e.payload))).toContain('Delivery invoicing');
    });

    it('refuses to sign when the item’s tax is not the tax the delivery was charged, and sends nothing', async () => {
      const zero = await product({ tax: '0', name: 'Delivery at zero' });
      await setMode('with_goods', zero);
      const { order } = await delivered(16);
      const { service: signing, sent } = signer();
      const result = await signing.processOrderDocument({ orderId: order.id, documentType: 'tax_invoice', invoiceNumber: `INV-${tag}-3` });
      expect(result).toMatchObject({ outcome: 'fail', reason: 'DELIVERY_TAX_MISMATCH' });
      expect(sent).toHaveLength(0);
    });
  });

  describe('on its own invoice', () => {
    it('signs the products without the delivery, and the delivery service apart, each with its own number and its own record', async () => {
      const service = await product({ name: 'Delivery service' });
      await setMode('separate', service);
      const { order, productId } = await delivered();
      const { service: signing, sent } = signer();
      const goods = await signing.processOrderDocument({ orderId: order.id, documentType: 'tax_invoice', invoiceNumber: `INV-${tag}-4` });
      const delivery = await signing.processOrderDeliveryDocument({ orderId: order.id, invoiceNumber: `INV-${tag}-5` });
      expect([goods.outcome, delivery.outcome]).toEqual(['sign', 'sign']);
      const [g, d] = sent;
      expect(g?.lines.map((l) => l.productId)).toEqual([productId]);
      expect(g?.total).toBe(order.totalAmount - 348);
      expect(d?.lines).toEqual([{ productId: service, qty: 1, unitPrice: 348, amount: 348 }]);
      expect(d?.total).toBe(348);
      expect(Math.round(((g?.total ?? 0) + (d?.total ?? 0)) * 100) / 100).toBe(order.totalAmount);
      // Each is its own document in the log, and the delivery's status is on the delivery record, not the order's.
      const keys = (await db.select().from(schema.kraSigningEvents).where(eq(schema.kraSigningEvents.documentId, order.id))).map((e) => e.documentKey);
      expect(new Set(keys)).toEqual(new Set([`order:${order.id}:tax_invoice`, `order_delivery:${order.id}:tax_invoice`]));
      expect((await c.orderDeliveries.forOrder(companyId, order.id))?.invoiceKraStatus).toBe('transmitted');
    });

    it('issues the delivery invoice with the goods invoice, from the same tax invoice series, once', async () => {
      const service = await product();
      await setMode('separate', service);
      const { order } = await delivered();
      const pdf = (c.invoices as unknown as { deps: { invoicePdf: { generate: unknown } } }).deps.invoicePdf;
      const original = pdf.generate;
      const titles: (string | null | undefined)[] = [];
      pdf.generate = (payload: { documentTitle?: string | null; items: { sku: string }[]; totalAmount: number }) => {
        titles.push(payload.documentTitle);
        return Promise.resolve(Buffer.from(`pdf ${payload.items.map((i) => i.sku).join(',')} ${String(payload.totalAmount)}`));
      };
      try {
        const goods = await c.invoices.generatePdf(order.id, 'tax_invoice');
        await vi.waitFor(async () => expect(await db.select().from(schema.invoiceDocuments).where(eq(schema.invoiceDocuments.orderId, order.id))).toHaveLength(2));
        const again = await c.invoices.generatePdf(order.id, 'delivery_invoice');
        const rows = await db.select().from(schema.invoiceDocuments).where(eq(schema.invoiceDocuments.orderId, order.id));
        expect(rows.map((r) => r.documentType).sort()).toEqual(['delivery_invoice', 'tax_invoice']);
        expect(again.invoiceNumber).toBe(rows.find((r) => r.documentType === 'delivery_invoice')?.invoiceNumber);
        expect(again.invoiceNumber).not.toBe(goods.invoiceNumber);
        const delivery = rows.find((r) => r.documentType === 'delivery_invoice');
        expect(delivery).toMatchObject({ subtotal: '300.00', tax: '48.00', shippingFee: '0.00', totalAmount: '348.00' });
        const main = rows.find((r) => r.documentType === 'tax_invoice');
        expect(Number(main?.totalAmount) + Number(delivery?.totalAmount)).toBe(order.totalAmount);
        expect(titles).toContain('Tax Invoice: Delivery Service');
      } finally {
        pdf.generate = original;
      }
    });

    it('has no delivery invoice to give when delivery is billed with the goods, or there is no delivery', async () => {
      const service = await product();
      await setMode('with_goods', service);
      const { order } = await delivered();
      await expect(c.invoices.generatePdf(order.id, 'delivery_invoice')).rejects.toThrow(/no separate delivery invoice/);
    });
  });

  /** The order's tax invoice issued (and, when delivery has its own invoice, that too), with the PDF stubbed. */
  const invoiced = async (orderId: string, documents: number) => {
    const pdf = (c.invoices as unknown as { deps: { invoicePdf: { generate: unknown } } }).deps.invoicePdf;
    const original = pdf.generate;
    pdf.generate = () => Promise.resolve(Buffer.from('pdf'));
    try {
      await c.invoices.generatePdf(orderId, 'tax_invoice');
      await vi.waitFor(async () => expect(await db.select().from(schema.invoiceDocuments).where(eq(schema.invoiceDocuments.orderId, orderId))).toHaveLength(documents));
    } finally {
      pdf.generate = original;
    }
  };

  describe('credit notes', () => {
    it('credit the delivery as a line of the invoice it is on, and give back nothing to stock, rebate or points for it', async () => {
      const service = await product({ name: 'Delivery service' });
      await setMode('with_goods', service);
      const { order, productId } = await delivered();
      await invoiced(order.id, 1);
      const view = await c.creditNotes.creditableForOrder(order.id);
      expect(view.invoiceTotal).toBe(order.totalAmount);
      expect(view.deliveryInvoice).toBeNull();
      expect(view.lines.map((l) => l.productId).sort()).toEqual([productId, service].sort());
      expect(view.lines.find((l) => l.productId === service)).toMatchObject({ description: 'Delivery', soldQuantity: 1, remainingQuantity: 1, remainingAmount: 348 });

      const cn = await c.creditNotes.issueForOrder({ orderId: order.id, lines: [{ productId: service, quantity: 1 }], reason: { code: 'other', note: 'Delivery was late' }, issuedBy: 'user-1' });
      expect(Number(cn.totalAmount)).toBe(348);
      expect(cn.originalDocumentKey).toBe(`order:${order.id}:tax_invoice`);
      await expect(c.creditNotes.issueForOrder({ orderId: order.id, lines: [{ productId: service, quantity: 1 }], reason: { code: 'other', note: 'Again' }, issuedBy: 'user-1' })).rejects.toThrow(/credit/i);
      // The goods that remain can still be credited (at their line price, as ever), and the delivery stays credited once.
      const rest = await c.creditNotes.issueForOrder({ orderId: order.id, lines: [{ productId, quantity: 1 }], reason: { code: 'other', note: 'Rest' }, issuedBy: 'user-1' });
      expect(Number(rest.totalAmount)).toBe(1000);
    });

    it('credit a delivery on its own invoice against that invoice, in a credit note of its own, and nothing else can credit it', async () => {
      const service = await product({ name: 'Delivery service' });
      await setMode('separate', service);
      const { order, productId } = await delivered();
      await invoiced(order.id, 2);
      const view = await c.creditNotes.creditableForOrder(order.id);
      expect(view.invoiceTotal).toBe(order.totalAmount - 348);
      expect(view.lines.map((l) => l.productId)).toEqual([productId]);
      expect(view.deliveryInvoice).toEqual({ description: 'Delivery', amount: 348, credited: 0, remaining: 348 });
      // The goods invoice does not carry the delivery, so a line for it there is refused.
      await expect(c.creditNotes.issueForOrder({ orderId: order.id, lines: [{ productId: service, quantity: 1 }], reason: { code: 'other', note: 'x' }, issuedBy: 'user-1' })).rejects.toThrow(/not on the original invoice/);

      const cn = await c.creditNotes.issueForDelivery({ orderId: order.id, reason: { code: 'other', note: 'Delivery was late' }, issuedBy: 'user-1' });
      expect(Number(cn.totalAmount)).toBe(348);
      expect(cn.originalDocumentKey).toBe(`order_delivery:${order.id}:tax_invoice`);
      expect((await c.creditNotes.creditableForOrder(order.id)).deliveryInvoice).toMatchObject({ credited: 348, remaining: 0 });
      await expect(c.creditNotes.issueForDelivery({ orderId: order.id, reason: { code: 'other', note: 'Again' }, issuedBy: 'user-1' })).rejects.toThrow(/credit/i);
    });

    it('have no delivery invoice to credit when delivery is on the goods invoice', async () => {
      const service = await product();
      await setMode('with_goods', service);
      const { order } = await delivered();
      await invoiced(order.id, 1);
      await expect(c.creditNotes.issueForDelivery({ orderId: order.id, reason: { code: 'other', note: 'x' }, issuedBy: 'user-1' })).rejects.toThrow(/no separate delivery invoice/);
    });

    it('follow how the invoice was issued, not what the setting says now', async () => {
      const service = await product();
      await setMode('with_goods', service);
      const { order } = await delivered();
      await invoiced(order.id, 1);
      await setMode('separate', service);
      const view = await c.creditNotes.creditableForOrder(order.id);
      expect(view.invoiceTotal).toBe(order.totalAmount);
      expect(view.deliveryInvoice).toBeNull();
      expect(view.lines.map((l) => l.productId)).toContain(service);
    });

    it('are sent to KRA against the delivery invoice, for the delivery service item', async () => {
      const service = await product({ name: 'Delivery service' });
      await setMode('separate', service);
      const { order } = await delivered();
      await invoiced(order.id, 2);
      const { service: signing } = signer();
      await signing.processOrderDocument({ orderId: order.id, documentType: 'tax_invoice', invoiceNumber: `INV-${tag}-c1` });
      await signing.processOrderDeliveryDocument({ orderId: order.id, invoiceNumber: `INV-${tag}-c2` });
      const cn = await c.creditNotes.issueForDelivery({ orderId: order.id, reason: { code: 'other', note: 'Delivery was late' }, issuedBy: 'user-1' });
      const credits: { original: string | undefined; lines: { itemCode: string; qty: number; amount: number }[] }[] = [];
      const policy = { decide: () => Promise.resolve({ outcome: 'sign', reason: 'SIGN', scope: 'company', branchId: null, mode: 'etims', gates: [], settings: {} }) };
      const transmissions = {
        transmitCreditNote: (i: { originalTraderInvoiceNo?: string; lines: { itemCode: string; qty: number; amount: number }[] }) => {
          credits.push({ original: i.originalTraderInvoiceNo, lines: i.lines });
          return Promise.resolve({ id: null, scuReceiptNo: '2', verificationUrl: null, attempts: 1 });
        },
      };
      const creditSigner = new SigningService(db, policy as never, {} as never, transmissions as never);
      const result = await creditSigner.processCreditNote(cn.id);
      expect(result.outcome).toBe('sign');
      expect(credits).toHaveLength(1);
      expect(credits[0]?.original).toBe(`INV-${tag}-c2`);
      expect(credits[0]?.lines).toEqual([expect.objectContaining({ itemCode: `KRA-${service}`, qty: 1, amount: 348 })]);
    });
  });

  describe('the delivery invoice on the order timeline', () => {
    const stagesOf = async (orderId: string) => (await db.select().from(schema.orderStageEvents).where(eq(schema.orderStageEvents.orderId, orderId))).filter((e) => e.stage.startsWith('delivery_invoice_'));

    it('shows when it was signed, and leaves the order’s own KRA status to the goods invoice', async () => {
      const service = await product();
      await setMode('separate', service);
      const { order } = await delivered();
      const { service: signing } = signer();
      await signing.processOrderDocument({ orderId: order.id, documentType: 'tax_invoice', invoiceNumber: `INV-${tag}-t1` });
      const [afterGoods] = await db.select({ kra: schema.orders.kraTransmissionStatus }).from(schema.orders).where(eq(schema.orders.id, order.id));
      await signing.processOrderDeliveryDocument({ orderId: order.id, invoiceNumber: `INV-${tag}-t2` });
      const stages = await stagesOf(order.id);
      expect(stages.map((e) => [e.stage, e.outcome])).toEqual([['delivery_invoice_signed', 'succeeded']]);
      expect(stages[0]?.occurredAt).toBeInstanceOf(Date);
      const [after] = await db.select({ kra: schema.orders.kraTransmissionStatus }).from(schema.orders).where(eq(schema.orders.id, order.id));
      expect(after?.kra).toBe(afterGoods?.kra);
      expect(after?.kra).toBe('transmitted');
    });

    it('shows the reason when it could not be signed', async () => {
      await setMode('separate', null);
      const { order } = await delivered();
      const { service: signing } = signer();
      await signing.processOrderDeliveryDocument({ orderId: order.id, invoiceNumber: `INV-${tag}-t3` });
      const stages = await stagesOf(order.id);
      expect(stages.map((e) => [e.stage, e.outcome, e.reasonCode])).toEqual([['delivery_invoice_failed', 'failed', 'DELIVERY_ITEM_NOT_SET']]);
    });
  });

  describe('an order with no delivery', () => {
    it('is invoiced and signed exactly as before, in either mode', async () => {
      const service = await product();
      const p = await product();
      const loc = await c.stockLocations.create(companyId, { code: code(), name: 'Plain shelf', kind: 'store', branchId: null });
      madeLocations.push(loc.id);
      await db.transaction((tx) => c.stockLedger.post(tx, { companyId, productId: p, locationId: loc.id, type: 'receipt', quantity: 5, unitCost: 10, actor: { type: 'job' } }));
      const r = await createOrder({ orderNumber: `DB-${randomUUID()}`, customerName: 'Plain', customerEmail: `db-${randomUUID()}@bill.test`, customerPhone: '0700000000', shippingAddress: { street: '1 Test Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' }, items: [{ productId: p, quantity: 1 }], currency: 'KES', paymentMethod: 'mpesa_daraja' });
      const order = r.order;
      expect(order).toBeDefined();
      await setMode('with_goods', service);
      const { service: signing, sent } = signer();
      const result = await signing.processOrderDocument({ orderId: order?.id ?? '', documentType: 'tax_invoice', invoiceNumber: `INV-${tag}-plain` });
      expect(result.outcome).toBe('sign');
      expect(sent[0]?.lines.map((l) => l.productId)).toEqual([p]);
      expect(sent[0]?.total).toBe(order?.totalAmount);
      // Whatever the company's choice, an order with nothing to separate is laid out as it always was.
      for (const mode of ['with_goods', 'separate'] as const) {
        await setMode(mode, service);
        const planned = await c.invoices.planFor(order as never, 'tax_invoice');
        expect(planned.figures.deliveryLine).toBeNull();
        expect(planned.plan.deliveryInvoice).toBeNull();
        expect(planned.figures.totalAmount).toBe(order?.totalAmount);
        expect(planned.figures.taxRows).toEqual([{ label: 'VAT', amount: order?.tax }]);
      }
    });
  });
});
