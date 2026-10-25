import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  glAccounts, procurementCategories, products, purchaseOrderAmendments, purchaseOrderEvents, purchaseOrderLines, purchaseOrderVersions, purchaseOrders, rfqAwards, rfqLines, rfqQuoteLines, rfqQuotes, rfqs, vendorAdvancePayments, vendorSettings, vendors,
  type PurchaseOrderRow, type PurchaseOrderStatus,
} from '@/server/db/drizzle/schema';
import { has, trimToNull } from '@/lib/values';
import { amendmentNeedsApproval, checkPoHeader, checkPoLine, describeChanges, lineAmounts, orderTotals, toMoney, type PoHeaderForm, type PoLineForm, type Snapshot } from '@/lib/purchase-order';
import type { NumberSeriesService } from '@/server/kernel/numbering/service';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { FinanceError, type FinanceContext } from '@/server/domains/finance/errors';
import type { VendorNotifier } from './notifier';
import type { PrequalLifecycle } from './prequal-lifecycle';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];
interface Actor { type: 'user' | 'system' | 'job' | 'integration'; id: string | null }

const MAX_LINES = 300;
/** Statuses from which an order can be changed only by an amendment. */
const RELEASED: PurchaseOrderStatus[] = ['approved', 'sent', 'confirmed'];

export interface PoSubmitRights {
  maySkipRfq: boolean;
  mayOverrideQualification: boolean;
  overrideReason?: string;
}

export interface PoListFilter {
  status?: string;
  vendorId?: string;
  before?: { createdAt: string; id: string } | null;
  limit?: number;
}

export interface AmendInput {
  header: Pick<PoHeaderForm, 'expectedDate' | 'paymentTerms' | 'deliveryTerms' | 'notesToVendor' | 'requiresAdvancePayment'>;
  lines: (PoLineForm & { id?: string })[];
  reason: string;
}

/**
 * The purchase order as a document (design doc §9): written as a draft, sent for approval by someone other than its writer,
 * given its number when approved, sent to the vendor, confirmed by the vendor, and from then on changed only by amendments that
 * are kept as numbered versions. Vendors must be qualified in the order's category, and an order above the policy value needs a
 * request for quotation unless someone allowed to skip it says why.
 */
export class PurchaseOrderService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly numbering: NumberSeriesService,
    private readonly qualification: PrequalLifecycle,
    private readonly notify?: VendorNotifier,
  ) {}

  private async event(tx: Tx | DrizzleDb, actor: Actor, poId: string, event: string, from: string | null, to: string | null, extra: { reason?: string | null; data?: Record<string, unknown> } = {}): Promise<void> {
    await tx.insert(purchaseOrderEvents).values({ poId, event, fromStatus: from, toStatus: to, reasonText: extra.reason ?? null, data: extra.data ?? {}, actorType: actor.type, actorId: actor.id });
  }

  private async lock(tx: Tx, companyId: string, poId: string): Promise<PurchaseOrderRow> {
    const [po] = await tx.select().from(purchaseOrders).where(and(eq(purchaseOrders.companyId, companyId), eq(purchaseOrders.id, poId))).for('update');
    if (po === undefined) throw new FinanceError('NOT_FOUND', 'That purchase order does not exist.');
    return po;
  }

  async settings(companyId: string) {
    const [s] = await this.db.select().from(vendorSettings).where(eq(vendorSettings.companyId, companyId));
    return {
      rfqRequiredAbove: s?.rfqRequiredAbove ?? null,
      amendmentTolerancePercent: s?.amendmentTolerancePercent ?? '0',
      receiptTolerancePercent: s?.receiptTolerancePercent ?? '0',
      inputTaxAccountId: s?.inputTaxAccountId ?? null,
      invoicePriceTolerancePercent: s?.invoicePriceTolerancePercent ?? '2',
      invoicePriceToleranceAmount: s?.invoicePriceToleranceAmount ?? '100',
      invoiceQuantityTolerancePercent: s?.invoiceQuantityTolerancePercent ?? '0',
      paymentThreeEyesAbove: s?.paymentThreeEyesAbove ?? '100000',
      watchDuplicateWindowDays: String(s?.watchDuplicateWindowDays ?? 7),
      watchNewVendorDays: String(s?.watchNewVendorDays ?? 30),
      watchNewVendorAmount: s?.watchNewVendorAmount ?? '100000',
      holdFlaggedPayments: s?.holdFlaggedPayments ?? true,
    };
  }

  /** An account as people read it: number and name. */
  async accountLabel(companyId: string, accountId: string): Promise<string | null> {
    const [a] = await this.db.select({ no: glAccounts.no, name: glAccounts.name }).from(glAccounts).where(and(eq(glAccounts.companyId, companyId), eq(glAccounts.id, accountId)));
    return a === undefined ? null : `${a.no} ${a.name}`;
  }

  async saveSettings(
    ctx: FinanceContext,
    input: { rfqRequiredAbove: string; amendmentTolerancePercent: string; receiptTolerancePercent?: string; inputTaxAccountId?: string; invoicePriceTolerancePercent?: string; invoicePriceToleranceAmount?: string; invoiceQuantityTolerancePercent?: string; paymentThreeEyesAbove?: string; watchDuplicateWindowDays?: string; watchNewVendorDays?: string; watchNewVendorAmount?: string; holdFlaggedPayments?: boolean },
  ): Promise<void> {
    const above = trimToNull(input.rfqRequiredAbove);
    if (above !== null && !/^\d{1,12}(\.\d{1,2})?$/.test(above)) throw new FinanceError('INVALID', 'The value above which a request for quotation is required is an amount, like 500000, or empty for never.');
    const percent = (value: string | undefined, fallback: string, what: string): string => {
      const v = (value ?? '').trim() === '' ? fallback : (value ?? '').trim();
      if (!/^\d{1,3}(\.\d{1,2})?$/.test(v) || Number(v) > 100) throw new FinanceError('INVALID', `${what} is a percentage from 0 to 100.`);
      return v;
    };
    const tol = percent(input.amendmentTolerancePercent, '0', 'The tolerance');
    const rec = percent(input.receiptTolerancePercent, '0', 'The delivery tolerance');
    const pricePct = percent(input.invoicePriceTolerancePercent, '2', 'The invoice price tolerance');
    const qtyPct = percent(input.invoiceQuantityTolerancePercent, '0', 'The invoice quantity tolerance');
    const amountText = (input.invoicePriceToleranceAmount ?? '').trim() === '' ? '100' : (input.invoicePriceToleranceAmount ?? '').trim();
    if (!/^\d{1,12}(\.\d{1,2})?$/.test(amountText)) throw new FinanceError('INVALID', 'The invoice price tolerance amount is an amount, like 100.');
    const threeText = (input.paymentThreeEyesAbove ?? '').trim() === '' ? '100000' : (input.paymentThreeEyesAbove ?? '').trim();
    if (!/^\d{1,12}(\.\d{1,2})?$/.test(threeText)) throw new FinanceError('INVALID', 'The value from which a payment needs three people is an amount, like 100000, or 0 for never.');
    const whole = (value: string | undefined, fallback: number, max: number, what: string): number => {
      const t = (value ?? '').trim();
      if (t === '') return fallback;
      if (!/^\d{1,4}$/.test(t) || Number(t) > max) throw new FinanceError('INVALID', `${what} is a whole number of days from 0 to ${String(max)}.`);
      return Number(t);
    };
    const dupDays = whole(input.watchDuplicateWindowDays, 7, 365, 'The window for look-alike invoices');
    const newDays = whole(input.watchNewVendorDays, 30, 3650, 'The time a vendor counts as new');
    const newAmount = (input.watchNewVendorAmount ?? '').trim() === '' ? '100000' : (input.watchNewVendorAmount ?? '').trim();
    if (!/^\d{1,12}(\.\d{1,2})?$/.test(newAmount)) throw new FinanceError('INVALID', 'The payment value to watch for a new vendor is an amount, like 100000, or 0 for never.');
    let tax: string | null = null;
    if (has(input.inputTaxAccountId)) {
      const [account] = await this.db.select({ id: glAccounts.id }).from(glAccounts).where(and(eq(glAccounts.companyId, ctx.companyId), eq(glAccounts.id, input.inputTaxAccountId), eq(glAccounts.type, 'posting'), eq(glAccounts.blocked, false)));
      if (account === undefined) throw new FinanceError('INVALID', 'Choose an account that can be posted to for the input tax.');
      tax = account.id;
    }
    // What the caller did not mention is left as it is.
    const values = {
      rfqRequiredAbove: above,
      amendmentTolerancePercent: tol,
      receiptTolerancePercent: rec,
      ...(input.inputTaxAccountId === undefined ? {} : { inputTaxAccountId: tax }),
      ...(input.invoicePriceTolerancePercent === undefined ? {} : { invoicePriceTolerancePercent: pricePct }),
      ...(input.invoicePriceToleranceAmount === undefined ? {} : { invoicePriceToleranceAmount: amountText }),
      ...(input.invoiceQuantityTolerancePercent === undefined ? {} : { invoiceQuantityTolerancePercent: qtyPct }),
      ...(input.paymentThreeEyesAbove === undefined ? {} : { paymentThreeEyesAbove: threeText }),
      ...(input.watchDuplicateWindowDays === undefined ? {} : { watchDuplicateWindowDays: dupDays }),
      ...(input.watchNewVendorDays === undefined ? {} : { watchNewVendorDays: newDays }),
      ...(input.watchNewVendorAmount === undefined ? {} : { watchNewVendorAmount: newAmount }),
      ...(input.holdFlaggedPayments === undefined ? {} : { holdFlaggedPayments: input.holdFlaggedPayments }),
    };
    await this.db.insert(vendorSettings).values({ companyId: ctx.companyId, ...values }).onConflictDoUpdate({ target: vendorSettings.companyId, set: { ...values, updatedAt: new Date() } });
  }

  private checkLines(lines: PoLineForm[]): void {
    if (lines.length === 0) throw new FinanceError('INVALID', 'Add at least one line.');
    if (lines.length > MAX_LINES) throw new FinanceError('TOO_MANY', `An order can have at most ${String(MAX_LINES)} lines.`);
    lines.forEach((l, i) => {
      const first = Object.values(checkPoLine(l))[0];
      if (has(first)) throw new FinanceError('INVALID', `Line ${String(i + 1)}: ${first}`);
    });
  }

  private lineRows(poId: string, lines: PoLineForm[], awardIds: (string | null)[] = []) {
    return lines.map((l, i) => ({
      poId,
      position: i,
      productId: trimToNull(l.productId),
      description: l.description.trim(),
      specification: trimToNull(l.specification),
      quantity: l.quantity.trim(),
      unit: l.unit.trim(),
      unitPrice: l.unitPrice.trim(),
      discountPercent: l.discountPercent.trim() === '' ? '0' : l.discountPercent.trim(),
      taxRate: l.taxRate.trim() === '' ? '0' : l.taxRate.trim(),
      lineTotal: toMoney(lineAmounts(l).total),
      expectedDate: trimToNull(l.expectedDate),
      awardId: awardIds[i] ?? null,
    }));
  }

  private async vendorOf(tx: Tx | DrizzleDb, companyId: string, vendorId: string) {
    const [v] = await tx.select({ id: vendors.id, status: vendors.status, block: vendors.block, legalName: vendors.legalName }).from(vendors).where(and(eq(vendors.companyId, companyId), eq(vendors.id, vendorId)));
    if (v === undefined) throw new FinanceError('NOT_FOUND', 'That vendor does not exist.');
    return v;
  }

  /** Creates (id null) or rewrites a draft. Only someone allowed to flag advances can turn that flag on or off. */
  async saveDraft(ctx: FinanceContext, id: string | null, header: PoHeaderForm, lines: PoLineForm[], mayFlagAdvance: boolean): Promise<{ id: string }> {
    const first = Object.values(checkPoHeader(header))[0];
    if (has(first)) throw new FinanceError('INVALID', first);
    this.checkLines(lines);
    const totals = orderTotals(lines);
    return await this.db.transaction(async (tx) => {
      const v = await this.vendorOf(tx, ctx.companyId, header.vendorId);
      if (v.status === 'archived') throw new FinanceError('NOT_ALLOWED', 'An archived vendor cannot be ordered from.');
      const [cat] = await tx.select({ id: procurementCategories.id }).from(procurementCategories).where(and(eq(procurementCategories.companyId, ctx.companyId), eq(procurementCategories.id, header.categoryId)));
      if (cat === undefined) throw new FinanceError('NOT_FOUND', 'That category does not exist.');
      let existing: PurchaseOrderRow | null = null;
      if (id !== null) {
        existing = await this.lock(tx, ctx.companyId, id);
        if (existing.status !== 'draft') throw new FinanceError('NOT_DRAFT', 'Only a draft can be edited. Change a released order by an amendment.');
      }
      if (header.requiresAdvancePayment !== (existing?.requiresAdvancePayment ?? false) && !mayFlagAdvance) throw new FinanceError('NOT_ALLOWED', 'Only someone allowed to flag advance payments can change that setting.');
      const fromRfq = existing?.rfqId != null;
      if (!fromRfq && !has(header.noRfqReason)) throw new FinanceError('INVALID', 'Say why this order is not from a request for quotation.');
      const values = {
        vendorId: header.vendorId,
        categoryId: header.categoryId,
        orderDate: header.orderDate,
        expectedDate: trimToNull(header.expectedDate),
        currency: header.currency.trim().toUpperCase(),
        paymentTerms: trimToNull(header.paymentTerms),
        deliveryTerms: trimToNull(header.deliveryTerms),
        notesToVendor: trimToNull(header.notesToVendor),
        internalNotes: trimToNull(header.internalNotes),
        requiresAdvancePayment: header.requiresAdvancePayment,
        noRfq: !fromRfq,
        noRfqReason: fromRfq ? null : header.noRfqReason.trim().slice(0, 500),
        subtotal: toMoney(totals.subtotal),
        taxTotal: toMoney(totals.tax),
        total: toMoney(totals.total),
        updatedAt: new Date(),
      };
      let poId: string;
      if (existing === null) {
        const [made] = await tx.insert(purchaseOrders).values({ companyId: ctx.companyId, ...values, buyerId: ctx.actor.id, createdBy: ctx.actor.id }).returning({ id: purchaseOrders.id });
        if (made === undefined) throw new FinanceError('NOT_SAVED', 'The order could not be saved.');
        poId = made.id;
        await this.event(tx, ctx.actor, poId, 'created', null, 'draft');
      } else {
        await tx.update(purchaseOrders).set(values).where(eq(purchaseOrders.id, existing.id));
        await tx.delete(purchaseOrderLines).where(eq(purchaseOrderLines.poId, existing.id));
        poId = existing.id;
      }
      await tx.insert(purchaseOrderLines).values(this.lineRows(poId, lines));
      return { id: poId };
    });
  }

  /** "Make order": one draft per awarded vendor, from what the award says, nothing re-typed. Safe to repeat. */
  async createFromAward(ctx: FinanceContext, rfqId: string, vendorId: string, today: string = businessDate()): Promise<{ id: string; created: boolean }> {
    return await this.db.transaction(async (tx) => {
      const [r] = await tx.select().from(rfqs).where(and(eq(rfqs.companyId, ctx.companyId), eq(rfqs.id, rfqId))).for('update');
      if (r === undefined) throw new FinanceError('NOT_FOUND', 'That request for quotation does not exist.');
      if (r.status !== 'awarded') throw new FinanceError('NOT_AWARDED', 'Orders are made from an award, once the request is awarded.');
      const [already] = await tx.select({ id: purchaseOrders.id }).from(purchaseOrders).where(and(eq(purchaseOrders.rfqId, rfqId), eq(purchaseOrders.vendorId, vendorId), sql`${purchaseOrders.status} <> 'cancelled'`));
      if (already !== undefined) return { id: already.id, created: false };
      const awards = await tx.select({ a: rfqAwards, line: rfqLines, ql: rfqQuoteLines, quote: rfqQuotes }).from(rfqAwards).innerJoin(rfqLines, eq(rfqLines.id, rfqAwards.rfqLineId)).innerJoin(rfqQuoteLines, eq(rfqQuoteLines.id, rfqAwards.quoteLineId)).innerJoin(rfqQuotes, eq(rfqQuotes.id, rfqQuoteLines.quoteId)).where(and(eq(rfqAwards.rfqId, rfqId), eq(rfqAwards.vendorId, vendorId))).orderBy(asc(rfqLines.position));
      if (awards.length === 0) throw new FinanceError('NOT_AWARDED', 'That vendor was not awarded anything on this request.');
      await this.vendorOf(tx, ctx.companyId, vendorId);
      const quote = required(awards[0]).quote;
      const lines: PoLineForm[] = awards.map(({ a, line, ql }) => ({
        productId: line.productId ?? '',
        description: line.description,
        specification: line.specification ?? '',
        quantity: a.quantity,
        unit: line.unit,
        unitPrice: a.unitPrice,
        discountPercent: '0',
        taxRate: ql.taxRate,
        expectedDate: ql.leadTimeDays === null ? (line.requiredDate ?? '') : new Date(new Date(`${today}T00:00:00Z`).getTime() + ql.leadTimeDays * 86_400_000).toISOString().slice(0, 10),
      }));
      this.checkLines(lines);
      const totals = orderTotals(lines);
      const [made] = await tx
        .insert(purchaseOrders)
        .values({
          companyId: ctx.companyId, vendorId, categoryId: r.categoryId, rfqId, quoteId: quote.id, orderDate: today, expectedDate: r.requiredBy, branchId: r.branchId, currency: r.currency,
          paymentTerms: quote.paymentTerms, deliveryTerms: quote.deliveryTerms, noRfq: false, subtotal: toMoney(totals.subtotal), taxTotal: toMoney(totals.tax), total: toMoney(totals.total), buyerId: ctx.actor.id, createdBy: ctx.actor.id,
        })
        .returning({ id: purchaseOrders.id });
      if (made === undefined) throw new FinanceError('NOT_SAVED', 'The order could not be made.');
      await tx.insert(purchaseOrderLines).values(this.lineRows(made.id, lines, awards.map((x) => x.a.id)));
      await this.event(tx, ctx.actor, made.id, 'created_from_award', null, 'draft', { data: { rfqId, rfqNumber: r.number } });
      return { id: made.id, created: true };
    });
  }

  async submit(ctx: FinanceContext, id: string, rights: PoSubmitRights, today: string = businessDate()): Promise<void> {
    const settings = await this.settings(ctx.companyId);
    await this.db.transaction(async (tx) => {
      const po = await this.lock(tx, ctx.companyId, id);
      if (po.status !== 'draft') throw new FinanceError('NOT_DRAFT', 'This order was already sent for approval.');
      if (po.createdBy !== ctx.actor.id) throw new FinanceError('NOT_YOURS', 'Only the person who wrote the order sends it for approval.');
      const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, id));
      if (n === 0 || Number(po.total) <= 0) throw new FinanceError('INVALID', 'An order needs at least one line and a value above zero.');
      const v = await this.vendorOf(tx, ctx.companyId, po.vendorId);
      if (v.status !== 'active' || v.block === 'all') throw new FinanceError('VENDOR_NOT_ACTIVE', 'This vendor is not active or is blocked, so it cannot be ordered from.');
      let override: string | null = null;
      if ((await this.qualification.qualificationOf(ctx.companyId, po.vendorId, po.categoryId, today)) === null) {
        if (!rights.mayOverrideQualification) throw new FinanceError('NOT_QUALIFIED', 'This vendor is not qualified in the order’s category. Qualify it first, or ask someone allowed to override.');
        if (!has(trimToNull(rights.overrideReason))) throw new FinanceError('OVERRIDE_REASON', 'Say why you are ordering from a vendor that is not qualified (this is reported).');
        override = (rights.overrideReason ?? '').trim().slice(0, 500);
      }
      if (po.noRfq && settings.rfqRequiredAbove !== null && Number(po.total) > Number(settings.rfqRequiredAbove) && !rights.maySkipRfq) {
        throw new FinanceError('RFQ_REQUIRED', `An order above ${settings.rfqRequiredAbove} needs a request for quotation. Someone allowed to skip it must send this one.`);
      }
      await tx.update(purchaseOrders).set({ status: 'pending_approval', submittedAt: new Date(), qualificationOverrideReason: override, updatedAt: new Date() }).where(eq(purchaseOrders.id, id));
      await this.event(tx, ctx.actor, id, 'submitted', 'draft', 'pending_approval', { reason: override, data: override === null ? {} : { qualificationOverride: true } });
    });
  }

  private snapshot(po: PurchaseOrderRow, lines: { description: string; quantity: string; unit: string; unitPrice: string; discountPercent: string; taxRate: string; expectedDate: string | null }[]): Snapshot & Record<string, unknown> {
    return { total: po.total, expectedDate: po.expectedDate, paymentTerms: po.paymentTerms, deliveryTerms: po.deliveryTerms, requiresAdvancePayment: po.requiresAdvancePayment, lines: lines.map((l) => ({ description: l.description, quantity: l.quantity, unit: l.unit, unitPrice: l.unitPrice, discountPercent: l.discountPercent, taxRate: l.taxRate, expectedDate: l.expectedDate })) };
  }

  /** A person other than the writer approves; the order gets its number and its first version. */
  async approve(ctx: FinanceContext, id: string, now: Date = new Date()): Promise<{ number: string }> {
    return await this.db.transaction(async (tx) => {
      const po = await this.lock(tx, ctx.companyId, id);
      if (po.status !== 'pending_approval') throw new FinanceError('NOT_PENDING', 'This order is not waiting for approval.');
      if (po.createdBy === ctx.actor.id) throw new FinanceError('FOUR_EYES', 'You wrote this order, so someone else must approve it.');
      const number = po.number ?? (await this.numbering.assign('purchase_order', { companyId: ctx.companyId, branchId: null, date: businessDate(now), document: { kind: 'purchase_order', id } }, tx)).number;
      await tx.update(purchaseOrders).set({ status: 'approved', number, approvedBy: ctx.actor.id, approvedAt: now, updatedAt: now }).where(eq(purchaseOrders.id, id));
      const lines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, id)).orderBy(asc(purchaseOrderLines.position));
      await tx.insert(purchaseOrderVersions).values({ poId: id, version: po.version, snapshot: this.snapshot(po, lines), reason: 'First release', createdBy: ctx.actor.id }).onConflictDoNothing();
      await this.event(tx, ctx.actor, id, 'approved', 'pending_approval', 'approved', { data: { number } });
      return { number };
    });
  }

  async reject(ctx: FinanceContext, id: string, reason: string): Promise<void> {
    const text = trimToNull(reason);
    if (!has(text)) throw new FinanceError('NOTE_REQUIRED', 'Say why the order is sent back.');
    await this.db.transaction(async (tx) => {
      const po = await this.lock(tx, ctx.companyId, id);
      if (po.status !== 'pending_approval') throw new FinanceError('NOT_PENDING', 'This order is not waiting for approval.');
      if (po.createdBy === ctx.actor.id) throw new FinanceError('FOUR_EYES', 'You wrote this order; take it back instead.');
      await tx.update(purchaseOrders).set({ status: 'draft', updatedAt: new Date() }).where(eq(purchaseOrders.id, id));
      await this.event(tx, ctx.actor, id, 'rejected', 'pending_approval', 'draft', { reason: text.slice(0, 500) });
    });
  }

  /** Takes an order back to a draft before it has gone to the vendor. Its number, if it has one, is kept. */
  async reopen(ctx: FinanceContext, id: string, reason: string): Promise<void> {
    const text = trimToNull(reason);
    if (!has(text)) throw new FinanceError('NOTE_REQUIRED', 'Say why the order is reopened.');
    await this.db.transaction(async (tx) => {
      const po = await this.lock(tx, ctx.companyId, id);
      if (po.status !== 'pending_approval' && po.status !== 'approved') throw new FinanceError('NOT_ALLOWED', 'Only an order that has not gone to the vendor can be reopened. Use an amendment after that.');
      await tx.update(purchaseOrders).set({ status: 'draft', approvedBy: null, approvedAt: null, updatedAt: new Date() }).where(eq(purchaseOrders.id, id));
      await this.event(tx, ctx.actor, id, 'reopened', po.status, 'draft', { reason: text.slice(0, 500) });
    });
  }

  async send(ctx: FinanceContext, id: string, now: Date = new Date()): Promise<void> {
    const d = await this.db.transaction(async (tx) => {
      const po = await this.lock(tx, ctx.companyId, id);
      if (po.status !== 'approved') throw new FinanceError('NOT_APPROVED', 'Only an approved order is sent to the vendor.');
      await tx.update(purchaseOrders).set({ status: 'sent', sentAt: now, updatedAt: now }).where(eq(purchaseOrders.id, id));
      await this.event(tx, ctx.actor, id, 'sent', 'approved', 'sent');
      return po;
    });
    await this.notify?.poSent(d.vendorId, d.number ?? '', d.total, d.currency, d.expectedDate);
  }

  /** Staff record that the vendor accepted (a phone call, a signed copy). The vendor can also confirm in the portal. */
  async recordConfirmation(ctx: FinanceContext, id: string, note: string, now: Date = new Date()): Promise<void> {
    const text = trimToNull(note);
    if (!has(text)) throw new FinanceError('NOTE_REQUIRED', 'Say how the vendor confirmed (who and how).');
    await this.confirmIn(id, ctx.companyId, { type: 'user', id: ctx.actor.id }, text.slice(0, 500), now);
  }

  /** Shared by staff recording and the vendor's own confirmation. */
  async confirmIn(id: string, companyId: string, actor: Actor, note: string | null, now: Date): Promise<void> {
    const po = await this.db.transaction(async (tx) => {
      const row = await this.lock(tx, companyId, id);
      if (row.status !== 'sent') throw new FinanceError('NOT_SENT', 'Only an order the vendor was sent, and has not confirmed yet, can be confirmed.');
      await tx.update(purchaseOrders).set({ status: 'confirmed', confirmedAt: now, confirmedBy: actor.id, confirmationNote: note, updatedAt: now }).where(eq(purchaseOrders.id, id));
      await this.event(tx, actor, id, 'confirmed', 'sent', 'confirmed', { reason: note });
      return row;
    });
    if (actor.type === 'user' && note === null) await this.notify?.poConfirmed(po.vendorId, po.number ?? '');
  }

  async cancel(ctx: FinanceContext, id: string, reason: string, now: Date = new Date()): Promise<void> {
    const text = trimToNull(reason);
    if (!has(text)) throw new FinanceError('NOTE_REQUIRED', 'Say why the order is cancelled.');
    const d = await this.db.transaction(async (tx) => {
      const po = await this.lock(tx, ctx.companyId, id);
      if (po.status === 'cancelled' || po.status === 'closed') throw new FinanceError('NOT_ALLOWED', `An order that is ${po.status} cannot be cancelled.`);
      const [moved] = await tx.select({ n: sql<number>`count(*)::int` }).from(purchaseOrderLines).where(and(eq(purchaseOrderLines.poId, id), sql`(${purchaseOrderLines.receivedQuantity} > 0 OR ${purchaseOrderLines.invoicedQuantity} > 0)`));
      if ((moved?.n ?? 0) > 0) throw new FinanceError('ALREADY_RECEIVED', 'Goods were received or invoiced against this order. Close it instead, with a reason.');
      const [advance] = await tx.select().from(vendorAdvancePayments).where(and(eq(vendorAdvancePayments.poId, id), inArray(vendorAdvancePayments.status, ['draft', 'pending_approval', 'approved', 'paid'])));
      if (advance?.status === 'paid') throw new FinanceError('ADVANCE_PAID', 'An advance was paid on this order. Get it refunded or applied first.');
      if (advance !== undefined) await tx.update(vendorAdvancePayments).set({ status: 'cancelled', decisionNote: 'The order was cancelled', updatedAt: now }).where(eq(vendorAdvancePayments.id, advance.id));
      await tx.update(purchaseOrders).set({ status: 'cancelled', cancelReason: text.slice(0, 500), closedAt: now, updatedAt: now }).where(eq(purchaseOrders.id, id));
      await tx.update(purchaseOrderAmendments).set({ status: 'withdrawn', decidedAt: now, decisionNote: 'The order was cancelled' }).where(and(eq(purchaseOrderAmendments.poId, id), eq(purchaseOrderAmendments.status, 'pending_approval')));
      await this.event(tx, ctx.actor, id, 'cancelled', po.status, 'cancelled', { reason: text.slice(0, 500) });
      return po;
    });
    if (d.sentAt !== null) await this.notify?.poCancelled(d.vendorId, d.number ?? '', text.slice(0, 500));
  }

  /** Force-closes an order that will not be completed (short delivery, no more wanted). */
  async close(ctx: FinanceContext, id: string, reason: string, now: Date = new Date()): Promise<void> {
    const text = trimToNull(reason);
    if (!has(text)) throw new FinanceError('NOTE_REQUIRED', 'Say why the order is closed.');
    await this.db.transaction(async (tx) => {
      const po = await this.lock(tx, ctx.companyId, id);
      if (!(['confirmed', 'sent', 'partially_received', 'received', 'partially_invoiced', 'invoiced'] as PurchaseOrderStatus[]).includes(po.status)) throw new FinanceError('NOT_ALLOWED', 'Only an order that has gone to the vendor can be closed.');
      await tx.update(purchaseOrders).set({ status: 'closed', closedAt: now, updatedAt: now }).where(eq(purchaseOrders.id, id));
      await this.event(tx, ctx.actor, id, 'closed', po.status, 'closed', { reason: text.slice(0, 500) });
    });
  }

  // ── Amendments ───────────────────────────────────────────────────────────────────────────────

  /**
   * Proposes a change to a released order. A change that raises no price and no value beyond the tolerance applies at once and goes to
   * the vendor to confirm again; anything else waits for someone else to approve it. Quantities cannot go below what was received.
   */
  async amend(ctx: FinanceContext, id: string, input: AmendInput, mayFlagAdvance: boolean, now: Date = new Date()): Promise<{ applied: boolean; version: number | null }> {
    const reason = trimToNull(input.reason);
    if (!has(reason)) throw new FinanceError('NOTE_REQUIRED', 'Say why the order changes.');
    this.checkLines(input.lines);
    const settings = await this.settings(ctx.companyId);
    const result = await this.db.transaction(async (tx) => {
      const po = await this.lock(tx, ctx.companyId, id);
      if (!RELEASED.includes(po.status)) throw new FinanceError('NOT_ALLOWED', 'Only an approved, sent or confirmed order can be amended. A draft is simply edited.');
      if (input.header.requiresAdvancePayment !== po.requiresAdvancePayment && !mayFlagAdvance) throw new FinanceError('NOT_ALLOWED', 'Only someone allowed to flag advance payments can change that setting.');
      const lines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, id)).orderBy(asc(purchaseOrderLines.position));
      for (const l of lines) {
        const kept = input.lines.find((x) => x.id === l.id);
        if (Number(l.receivedQuantity) > 0 || Number(l.invoicedQuantity) > 0) {
          if (kept === undefined) throw new FinanceError('ALREADY_RECEIVED', `“${l.description}” was received or invoiced, so it cannot be removed.`);
          if (Number(kept.quantity) < Math.max(Number(l.receivedQuantity), Number(l.invoicedQuantity))) throw new FinanceError('ALREADY_RECEIVED', `“${l.description}”: ${l.receivedQuantity} was already received, so the quantity cannot go below that.`);
        }
      }
      const totals = orderTotals(input.lines);
      const before = this.snapshot(po, lines);
      const after: Snapshot & Record<string, unknown> = {
        total: toMoney(totals.total),
        expectedDate: trimToNull(input.header.expectedDate),
        paymentTerms: trimToNull(input.header.paymentTerms),
        deliveryTerms: trimToNull(input.header.deliveryTerms),
        requiresAdvancePayment: input.header.requiresAdvancePayment,
        lines: input.lines.map((l) => ({ description: l.description.trim(), quantity: l.quantity.trim(), unit: l.unit.trim(), unitPrice: l.unitPrice.trim(), discountPercent: l.discountPercent.trim() === '' ? '0' : l.discountPercent.trim(), taxRate: l.taxRate.trim() === '' ? '0' : l.taxRate.trim(), expectedDate: trimToNull(l.expectedDate) })),
      };
      if (describeChanges(before, after).length === 0 && trimToNull(input.header.notesToVendor) === po.notesToVendor) throw new FinanceError('NO_CHANGE', 'Nothing changed.');
      const needs = amendmentNeedsApproval(before, after, Number(settings.amendmentTolerancePercent));
      const proposed = { header: input.header, lines: input.lines, snapshot: after, previousStatus: po.status };
      const [open] = await tx.select({ id: purchaseOrderAmendments.id }).from(purchaseOrderAmendments).where(and(eq(purchaseOrderAmendments.poId, id), eq(purchaseOrderAmendments.status, 'pending_approval')));
      if (open !== undefined) throw new FinanceError('PENDING', 'A change to this order is already waiting for approval. Decide it first.');
      const [row] = await tx.insert(purchaseOrderAmendments).values({ poId: id, status: needs ? 'pending_approval' : 'applied', reason: reason.slice(0, 500), proposed, needsApproval: needs, proposedBy: ctx.actor.id, decidedAt: needs ? null : now, decidedBy: needs ? null : ctx.actor.id }).returning({ id: purchaseOrderAmendments.id });
      if (row === undefined) throw new FinanceError('NOT_SAVED', 'The change could not be saved.');
      if (needs) {
        await tx.update(purchaseOrders).set({ status: 'amendment_pending', updatedAt: now }).where(eq(purchaseOrders.id, id));
        await this.event(tx, ctx.actor, id, 'amendment_proposed', po.status, 'amendment_pending', { reason: reason.slice(0, 500) });
        return { applied: false, version: null, notice: null };
      }
      const applied = await this.applyIn(tx, ctx.actor, po, proposed, row.id, reason, now);
      return { applied: true, version: applied.version, notice: applied };
    });
    if (result.notice !== null) await this.notify?.poAmended(result.notice.vendorId, result.notice.number, result.notice.version, result.notice.changes, reason.slice(0, 500));
    return { applied: result.applied, version: result.version };
  }

  private async applyIn(tx: Tx, actor: Actor, po: PurchaseOrderRow, proposed: Record<string, unknown>, amendmentId: string, reason: string, now: Date) {
    const header = proposed.header as AmendInput['header'];
    const inLines = proposed.lines as (PoLineForm & { id?: string })[];
    const after = proposed.snapshot as Snapshot;
    const previousStatus = proposed.previousStatus as PurchaseOrderStatus;
    const totals = orderTotals(inLines);
    const old = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, po.id)).orderBy(asc(purchaseOrderLines.position));
    const before = this.snapshot(po, old);
    await tx.execute(sql`SELECT set_config('qsell.po_amend', 'on', true)`);
    const keepIds = inLines.flatMap((l) => (l.id === undefined ? [] : [l.id]));
    for (const o of old) if (!keepIds.includes(o.id)) await tx.delete(purchaseOrderLines).where(eq(purchaseOrderLines.id, o.id));
    for (const [i, l] of inLines.entries()) {
      const row = this.lineRows(po.id, [l])[0];
      if (row === undefined) continue;
      if (l.id !== undefined && old.some((o) => o.id === l.id)) await tx.update(purchaseOrderLines).set({ ...row, position: i }).where(eq(purchaseOrderLines.id, l.id));
      else await tx.insert(purchaseOrderLines).values({ ...row, position: i });
    }
    const version = po.version + 1;
    const status: PurchaseOrderStatus = previousStatus === 'approved' ? 'approved' : 'sent';
    await tx.update(purchaseOrders).set({
      version, status, total: toMoney(totals.total), subtotal: toMoney(totals.subtotal), taxTotal: toMoney(totals.tax),
      expectedDate: trimToNull(header.expectedDate), paymentTerms: trimToNull(header.paymentTerms), deliveryTerms: trimToNull(header.deliveryTerms), notesToVendor: trimToNull(header.notesToVendor), requiresAdvancePayment: header.requiresAdvancePayment,
      // The vendor must confirm again; the sent date is kept.
      confirmedAt: null, confirmedBy: null, confirmationNote: null, updatedAt: now,
    }).where(eq(purchaseOrders.id, po.id));
    const updated = (await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, po.id)))[0] ?? po;
    const lines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, po.id)).orderBy(asc(purchaseOrderLines.position));
    await tx.insert(purchaseOrderVersions).values({ poId: po.id, version, snapshot: this.snapshot(updated, lines), reason: reason.slice(0, 500), createdBy: actor.id });
    await tx.update(purchaseOrderAmendments).set({ status: 'applied', appliedVersion: version, decidedAt: now, decidedBy: actor.id }).where(eq(purchaseOrderAmendments.id, amendmentId));
    await this.event(tx, actor, po.id, 'amended', po.status, status, { reason: reason.slice(0, 500), data: { version } });
    return { version, vendorId: po.vendorId, number: po.number ?? '', changes: describeChanges(before, after) };
  }

  /** Someone other than the proposer decides a change that needed approval. */
  async decideAmendment(ctx: FinanceContext, amendmentId: string, approve: boolean, note: string, now: Date = new Date()): Promise<void> {
    const text = trimToNull(note);
    if (!approve && !has(text)) throw new FinanceError('NOTE_REQUIRED', 'Say why the change is refused.');
    const result = await this.db.transaction(async (tx) => {
      const [a] = await tx.select({ a: purchaseOrderAmendments, companyId: purchaseOrders.companyId }).from(purchaseOrderAmendments).innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderAmendments.poId)).where(eq(purchaseOrderAmendments.id, amendmentId)).for('update', { of: purchaseOrderAmendments });
      if (a?.companyId !== ctx.companyId) throw new FinanceError('NOT_FOUND', 'That change does not exist.');
      if (a.a.status !== 'pending_approval') throw new FinanceError('NOT_PENDING', 'That change is not waiting for a decision.');
      if (a.a.proposedBy === ctx.actor.id) throw new FinanceError('FOUR_EYES', 'You proposed this change, so someone else must decide it.');
      const po = await this.lock(tx, ctx.companyId, a.a.poId);
      const previous = (a.a.proposed.previousStatus as PurchaseOrderStatus | undefined) ?? 'approved';
      if (!approve) {
        await tx.update(purchaseOrderAmendments).set({ status: 'rejected', decidedBy: ctx.actor.id, decidedAt: now, decisionNote: (text ?? '').slice(0, 500) }).where(eq(purchaseOrderAmendments.id, amendmentId));
        await tx.update(purchaseOrders).set({ status: previous, updatedAt: now }).where(eq(purchaseOrders.id, po.id));
        await this.event(tx, ctx.actor, po.id, 'amendment_refused', 'amendment_pending', previous, { reason: text });
        return null;
      }
      return await this.applyIn(tx, ctx.actor, po, a.a.proposed, amendmentId, a.a.reason, now);
    });
    if (result !== null) {
      const [row] = await this.db.select({ reason: purchaseOrderAmendments.reason }).from(purchaseOrderAmendments).where(eq(purchaseOrderAmendments.id, amendmentId));
      await this.notify?.poAmended(result.vendorId, result.number, result.version, result.changes, row?.reason ?? '');
    }
  }

  // ── Reading ──────────────────────────────────────────────────────────────────────────────────

  async list(companyId: string, f: PoListFilter = {}) {
    const limit = Math.min(Math.max(f.limit ?? 50, 1), 100);
    const conds = [eq(purchaseOrders.companyId, companyId)];
    if (has(f.status)) conds.push(eq(purchaseOrders.status, f.status as PurchaseOrderStatus));
    if (has(f.vendorId)) conds.push(eq(purchaseOrders.vendorId, f.vendorId));
    if (f.before) conds.push(sql`(${purchaseOrders.createdAt}::text, ${purchaseOrders.id}::text) < (${f.before.createdAt}, ${f.before.id})`);
    const found = await this.db
      .select({ po: purchaseOrders, vendor: vendors.legalName, stamp: sql<string>`${purchaseOrders.createdAt}::text` })
      .from(purchaseOrders)
      .innerJoin(vendors, eq(vendors.id, purchaseOrders.vendorId))
      .where(and(...conds))
      .orderBy(desc(purchaseOrders.createdAt), desc(purchaseOrders.id))
      .limit(limit + 1);
    const page = found.slice(0, limit);
    const last = page.at(-1);
    return { rows: page.map((x) => ({ ...x.po, vendorName: x.vendor })), next: found.length > limit && last !== undefined ? { createdAt: last.stamp, id: last.po.id } : null };
  }

  async get(companyId: string, id: string) {
    const [head] = await this.db
      .select({ po: purchaseOrders, vendor: vendors.legalName, vendorNumber: vendors.number, category: procurementCategories.name, rfqNumber: rfqs.number })
      .from(purchaseOrders)
      .innerJoin(vendors, eq(vendors.id, purchaseOrders.vendorId))
      .innerJoin(procurementCategories, eq(procurementCategories.id, purchaseOrders.categoryId))
      .leftJoin(rfqs, eq(rfqs.id, purchaseOrders.rfqId))
      .where(and(eq(purchaseOrders.companyId, companyId), eq(purchaseOrders.id, id)));
    if (head === undefined) return null;
    const [lines, versions, amendments, events, advances] = await Promise.all([
      this.db.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, id)).orderBy(asc(purchaseOrderLines.position)),
      this.db.select().from(purchaseOrderVersions).where(eq(purchaseOrderVersions.poId, id)).orderBy(desc(purchaseOrderVersions.version)),
      this.db.select().from(purchaseOrderAmendments).where(eq(purchaseOrderAmendments.poId, id)).orderBy(desc(purchaseOrderAmendments.createdAt)),
      this.db.select().from(purchaseOrderEvents).where(eq(purchaseOrderEvents.poId, id)).orderBy(desc(purchaseOrderEvents.id)).limit(100),
      this.db.select().from(vendorAdvancePayments).where(eq(vendorAdvancePayments.poId, id)).orderBy(desc(vendorAdvancePayments.createdAt)),
    ]);
    const productIds = lines.flatMap((l) => (l.productId === null ? [] : [l.productId]));
    const names = productIds.length === 0 ? [] : await this.db.select({ id: products.id, name: products.name }).from(products).where(inArray(products.id, productIds));
    return { po: head.po, vendorName: head.vendor, vendorNumber: head.vendorNumber, categoryName: head.category, rfqNumber: head.rfqNumber, lines: lines.map((l) => ({ ...l, productName: names.find((n) => n.id === l.productId)?.name ?? null })), versions, amendments, events, advances };
  }

  /** Orders still to be made from an awarded request: the awarded vendors with no order yet. */
  async toMake(companyId: string, rfqId: string) {
    const rows = await this.db.execute<{ vendor_id: string; name: string; lines: number; order_id: string | null }>(sql`
      SELECT a.vendor_id, v.legal_name AS name, count(*)::int AS lines,
        (SELECT p.id FROM purchase_orders p WHERE p.rfq_id = a.rfq_id AND p.vendor_id = a.vendor_id AND p.status <> 'cancelled' LIMIT 1) AS order_id
      FROM rfq_awards a JOIN vendors v ON v.id = a.vendor_id JOIN rfqs r ON r.id = a.rfq_id
      WHERE a.rfq_id = ${rfqId}::uuid AND r.company_id = ${companyId}::uuid GROUP BY a.rfq_id, a.vendor_id, v.legal_name ORDER BY v.legal_name`);
    return [...rows].map((r) => ({ vendorId: r.vendor_id, name: r.name, lines: r.lines, orderId: r.order_id }));
  }
}

function required<T>(v: T | undefined): T {
  if (v === undefined) throw new FinanceError('NOT_FOUND', 'Missing record.');
  return v;
}
