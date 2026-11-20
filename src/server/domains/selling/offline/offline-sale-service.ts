import { createHmac, randomBytes } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { offlineSales, offlineSellingSettings, offlineShiftKeys, productPackages, products, shifts, unitsOfMeasure } from '@/server/db/drizzle/schema';
import type { Actor } from '@/server/kernel/context';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { ReasonCodes, ReasonInput } from '@/server/kernel/reason-codes/service';
import { decryptCredentials, encryptCredentials } from '@/server/domains/payments/crypto';
import { isOfferedIn } from '@/lib/offered-in';
import type { CashSaleService } from '../cash-sales/cash-sale-service';
import type { ShiftService } from '../shifts/shift-service';
import { canonicalSale, limitProblem, limitsProblem, offlineRoom, OFFLINE_DEFAULTS, parseOfflineSale, sameSignature, type OfflineLimits, type SignedOfflineSale } from './offline-rules';

export class OfflineError extends Error {}

export type OfflineStatus = 'accepted' | 'needs_review' | 'parked' | 'rejected' | 'discarded';
export type IngestResult =
  | { ok: true; status: 'accepted' | 'needs_review'; orderNumber: string; receiptNumber: string | null; flags: string[] }
  | { ok: true; status: 'parked' | 'rejected' | 'discarded'; reason: string; flags: string[] }
  | { ok: false; error: string };

export interface OfflineSnapshot {
  shiftId: string;
  /** The key this till signs its offline sales with, for this shift only. */
  secret: string;
  limits: OfflineLimits;
  /** What this shift has already sold offline, so the till knows the room left. */
  soldSoFar: number;
  serverTime: string;
  products: { id: string; sku: string; name: string; price: number; decimals: number }[];
  methods: { id: string; name: string; kind: string; requiresReference: boolean }[];
}

export interface ReviewRow {
  id: string;
  saleKey: string;
  deviceRef: string;
  deviceTime: string;
  receivedAt: string;
  total: number;
  status: OfflineStatus;
  flags: string[];
  reason: string | null;
  orderNumber: string | null;
  cashier: string;
}


const money = (value: number): number => Math.round(value * 100) / 100;
const seal = (secret: string): string => JSON.stringify(encryptCredentials({ secret }));
const unseal = (stored: string): string => {
  const opened = decryptCredentials(JSON.parse(stored) as never);
  const secret = opened?.secret;
  return typeof secret === 'string' ? secret : '';
};
export const signSale = (secret: string, sale: Parameters<typeof canonicalSale>[0]): string => createHmac('sha256', secret).update(canonicalSale(sale)).digest('hex');

/** Selling at the counter with no connection, and bringing it in safely when the connection returns (docs/architecture/offline-selling.md). */
export class OfflineSaleService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly reasons: ReasonCodes,
    private readonly shifts: ShiftService,
    private readonly cashSales: CashSaleService,
  ) {}

  // ── The setting (its own permission) ───────────────────────────────────

  async settings(companyId: string): Promise<{ enabled: boolean; limits: OfflineLimits; version: number; updatedBy: string | null; updatedAt: string | null }> {
    const [row] = await this.db.select().from(offlineSellingSettings).where(eq(offlineSellingSettings.companyId, companyId)).limit(1);
    if (row === undefined) return { enabled: false, limits: { ...OFFLINE_DEFAULTS }, version: 0, updatedBy: null, updatedAt: null };
    return { enabled: row.enabled, limits: { maxPerShift: Number(row.maxPerShift), maxHours: row.maxHours }, version: row.version, updatedBy: row.updatedBy, updatedAt: row.updatedAt.toISOString() };
  }

  async saveSettings(companyId: string, actor: Actor, next: { enabled: boolean; limits: OfflineLimits }, reason: ReasonInput): Promise<void> {
    const problem = limitsProblem(next.limits);
    if (problem !== null) throw new OfflineError(problem);
    const why = await this.reasons.require(companyId, reason, 'offline_configuration');
    await this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(offlineSellingSettings).where(eq(offlineSellingSettings.companyId, companyId)).limit(1).for('update');
      const values = { enabled: next.enabled, maxPerShift: String(next.limits.maxPerShift), maxHours: next.limits.maxHours, updatedBy: actor.id ?? 'system', updatedAt: new Date() };
      if (before === undefined) await tx.insert(offlineSellingSettings).values({ companyId, ...values });
      else await tx.update(offlineSellingSettings).set({ ...values, version: before.version + 1 }).where(eq(offlineSellingSettings.companyId, companyId));
      await this.decisions.record({ companyId, actor, subject: { type: 'offline_selling_settings', id: companyId }, action: 'offline_selling_settings.changed', reason: why, inputs: before === undefined ? {} : { enabled: before.enabled, maxPerShift: Number(before.maxPerShift), maxHours: before.maxHours }, outcome: { enabled: next.enabled, ...next.limits } }, tx);
    });
  }

  // ── The till's snapshot and key ────────────────────────────────────────

  private async soldSoFar(shiftId: string): Promise<number> {
    const [row] = await this.db.select({ n: sql<string>`COALESCE(SUM(${offlineSales.total}), 0)::text` }).from(offlineSales).where(and(eq(offlineSales.shiftId, shiftId), inArray(offlineSales.status, ['accepted', 'needs_review', 'parked'])));
    return Number(row?.n ?? 0);
  }

  private async secretOf(shiftId: string, companyId: string): Promise<string> {
    const [row] = await this.db.select().from(offlineShiftKeys).where(eq(offlineShiftKeys.shiftId, shiftId)).limit(1);
    if (row !== undefined) return unseal(row.secret);
    const secret = randomBytes(32).toString('hex');
    await this.db.insert(offlineShiftKeys).values({ shiftId, companyId, secret: seal(secret) }).onConflictDoNothing();
    const [again] = await this.db.select().from(offlineShiftKeys).where(eq(offlineShiftKeys.shiftId, shiftId)).limit(1);
    return again === undefined ? secret : unseal(again.secret);
  }

  /** What a till needs to sell with no connection: the shift's key, the limits, and what it may sell and be paid with. Only for the person's own open shift, while online. */
  async snapshot(companyId: string, userId: string): Promise<{ ok: true; data: OfflineSnapshot } | { ok: false; error: string }> {
    const settings = await this.settings(companyId);
    if (!settings.enabled) return { ok: false, error: 'Offline selling is switched off.' };
    const open = await this.shifts.openForSale(companyId, userId);
    if (!open.ok) return open;
    const rows = await this.db
      .select({ id: products.id, sku: products.sku, name: products.name, price: products.price, taxRate: products.taxRate, inclusive: products.isTaxInclusive, decimals: unitsOfMeasure.decimals })
      .from(products)
      .leftJoin(unitsOfMeasure, eq(unitsOfMeasure.id, products.baseUnitId))
      .where(and(eq(products.isActive, true), eq(products.isSellable, true), sql`${products.deletedAt} IS NULL`, eq(products.soldOnlyInPackages, false), sql`'pos_cash_sale' = ANY(${products.offeredIn})`, sql`${products.id} NOT IN (SELECT ${productPackages.productId} FROM ${productPackages} WHERE ${productPackages.isActive})`, sql`${products.price} > 0`))
      .orderBy(products.name)
      .limit(5000);
    return {
      ok: true,
      data: {
        shiftId: open.shiftId,
        secret: await this.secretOf(open.shiftId, companyId),
        limits: settings.limits,
        soldSoFar: await this.soldSoFar(open.shiftId),
        serverTime: new Date().toISOString(),
        products: rows.map((r) => ({ id: r.id, sku: r.sku, name: r.name, price: money(r.inclusive !== false ? Number(r.price) : Number(r.price) * (1 + Number(r.taxRate ?? 0) / 100)), decimals: r.decimals ?? 0 })),
        methods: await this.cashSales.tenderMethods(companyId, open.branchId),
      },
    };
  }

  // ── Bringing a sale in ─────────────────────────────────────────────────

  private async keep(companyId: string, sale: SignedOfflineSale, status: OfflineStatus, input: { flags?: string[]; reason?: string; orderId?: string }): Promise<void> {
    await this.db.insert(offlineSales).values({ companyId, shiftId: sale.shiftId, saleKey: sale.key, deviceRef: sale.deviceRef, deviceTime: new Date(sale.deviceTime), total: String(sale.total), status, flags: input.flags ?? [], reason: input.reason ?? null, orderId: input.orderId ?? null, payload: sale as unknown as Record<string, unknown> }).onConflictDoNothing();
  }

  private async answerFor(row: typeof offlineSales.$inferSelect): Promise<IngestResult> {
    if (row.status === 'accepted' || row.status === 'needs_review') {
      const summary = row.orderId === null ? null : await this.cashSales.summary(row.orderId).catch(() => null);
      return { ok: true, status: row.status, orderNumber: summary?.orderNumber ?? '', receiptNumber: summary?.receiptNumber ?? null, flags: row.flags };
    }
    return { ok: true, status: row.status, reason: row.reason ?? '', flags: row.flags };
  }

  /**
   * Takes in one sale from a till: the shift must be the sender's own and open, the signature must be the one the shift's key makes, the
   * limits must hold, and then it becomes a normal cash sale at the price the customer was charged. What cannot be done is kept, never
   * dropped: refused (changed, over a limit, into a closed shift) or parked (the stock is not there yet). Sending it again changes nothing.
   */
  async ingest(companyId: string, who: { userId: string }, raw: unknown): Promise<IngestResult> {
    const settings = await this.settings(companyId);
    if (!settings.enabled) return { ok: false, error: 'Offline selling is switched off, so this sale cannot be taken in.' };
    const read = parseOfflineSale(raw);
    if (!read.ok) return { ok: false, error: read.error };
    const sale = read.sale;
    const [existing] = await this.db.select().from(offlineSales).where(eq(offlineSales.saleKey, sale.key)).limit(1);
    const [shift] = await this.db.select().from(shifts).where(and(eq(shifts.id, sale.shiftId), eq(shifts.companyId, companyId))).limit(1);
    if (shift?.openedBy !== who.userId) return { ok: false, error: 'This sale is not from one of your shifts.' };
    if (existing !== undefined) return await this.answerFor(existing);
    const refuse = async (reason: string, flags: string[] = []): Promise<IngestResult> => {
      await this.keep(companyId, sale, 'rejected', { reason, flags });
      await this.decisions.record({ companyId, actor: { type: 'user', id: who.userId }, subject: { type: 'offline_sale', id: sale.key }, action: 'offline_sale.rejected', outcome: { reason, total: sale.total, deviceRef: sale.deviceRef } });
      return { ok: true, status: 'rejected', reason, flags };
    };
    if (shift.status !== 'open') return await refuse('The shift was already closed, so the sale cannot be added to it.');
    const secret = await this.secretOf(shift.id, companyId);
    if (!sameSignature(signSale(secret, sale), sale.signature)) return await refuse('The sale was changed after it was rung up (its signature does not match).');
    const deviceMs = Date.parse(sale.deviceTime);
    const waited = Date.now() - deviceMs;
    const problem = limitProblem({ limits: settings.limits, soldSoFar: await this.soldSoFar(shift.id), total: sale.total, waitedMs: waited });
    if (problem !== null) return await refuse(problem);
    return await this.make(companyId, who.userId, sale, waited < -5 * 60_000 ? ['clock_ahead'] : []);
  }

  /** Makes the cash sale from a received offline sale (also used again for a parked one once its shortage is put right). */
  private async make(companyId: string, ownerId: string, sale: SignedOfflineSale, startFlags: string[]): Promise<IngestResult> {
    const flags = [...startFlags];
    const rows = await this.db.select().from(products).where(inArray(products.id, sale.lines.map((l) => l.productId)));
    if (rows.length !== sale.lines.length) {
      await this.keep(companyId, sale, 'rejected', { reason: 'A product on the sale no longer exists.' });
      return { ok: true, status: 'rejected', reason: 'A product on the sale no longer exists.', flags };
    }
    if (rows.some((r) => !r.isActive || !r.isSellable || r.deletedAt !== null || !isOfferedIn(r.offeredIn, 'pos_cash_sale'))) flags.push('no_longer_sold');
    const quotedItems = sale.lines.map((l) => {
      const p = rows.find((r) => r.id === l.productId);
      return { productId: l.productId, quantity: l.quantity, productName: p?.name ?? '', sku: p?.sku ?? '', lineAmount: money(l.unitPrice * l.quantity), taxRate: Number(p?.taxRate ?? 0), isTaxInclusive: true };
    });
    let tax = 0;
    for (const q of quotedItems) tax += q.lineAmount * (q.taxRate / (100 + q.taxRate));
    const quotedTotals = { subtotal: money(sale.total - tax), tax: money(tax), shippingFee: 0, totalAmount: sale.total };
    const who = { userId: ownerId, branchId: null };
    const priced = await this.cashSales.price(companyId, who, { customerId: null, lines: sale.lines.map((l) => ({ productId: l.productId, quantity: l.quantity })) }).catch(() => null);
    if (priced?.ok === true && Math.abs(priced.total - sale.total) > 0.005) flags.push('price_differs');
    const done = await this.cashSales.complete(companyId, who, { customerId: null, lines: sale.lines.map((l) => ({ productId: l.productId, quantity: l.quantity })), tenders: sale.tenders, saleKey: sale.key, offline: { quotedItems, quotedTotals } });
    if (done.ok) {
      const status = flags.length > 0 ? 'needs_review' : 'accepted';
      const [existing] = await this.db.select().from(offlineSales).where(eq(offlineSales.saleKey, sale.key)).limit(1);
      if (existing === undefined) await this.keep(companyId, sale, status, { flags, orderId: done.sale.orderId });
      else await this.db.update(offlineSales).set({ status, flags, reason: null, orderId: done.sale.orderId, updatedAt: new Date() }).where(eq(offlineSales.id, existing.id));
      await this.decisions.record({ companyId, actor: { type: 'user', id: ownerId }, subject: { type: 'order', id: done.sale.orderId }, action: 'offline_sale.accepted', outcome: { deviceRef: sale.deviceRef, total: sale.total, flags } });
      return { ok: true, status, orderNumber: done.sale.orderNumber, receiptNumber: done.sale.receiptNumber, flags };
    }
    // Not made yet (the stock is not there, a way of paying is not available): kept whole, shown to a person, and tried again once put right.
    const [existing] = await this.db.select().from(offlineSales).where(eq(offlineSales.saleKey, sale.key)).limit(1);
    if (existing === undefined) await this.keep(companyId, sale, 'parked', { flags, reason: done.error });
    else await this.db.update(offlineSales).set({ reason: done.error, flags, updatedAt: new Date() }).where(eq(offlineSales.id, existing.id));
    return { ok: true, status: 'parked', reason: done.error, flags };
  }

  // ── What needs a person ────────────────────────────────────────────────

  async review(companyId: string): Promise<ReviewRow[]> {
    const rows = await this.db.execute<{ id: string; sale_key: string; device_ref: string; device_time: string; received_at: string; total: string; status: OfflineStatus; flags: string[]; reason: string | null; order_number: string | null; cashier: string | null }>(sql`
      SELECT s.id::text, s.sale_key, s.device_ref, s.device_time::text, s.received_at::text, s.total::text, s.status, s.flags, s.reason, o.order_number, u.name AS cashier
        FROM offline_sales s
        JOIN shifts sh ON sh.id = s.shift_id
        LEFT JOIN orders o ON o.id = s.order_id
        LEFT JOIN users u ON u.id::text = sh.opened_by
       WHERE s.company_id = ${companyId}::uuid AND s.status IN ('needs_review', 'parked', 'rejected')
       ORDER BY s.received_at DESC LIMIT 100`);
    return rows.map((r) => ({ id: r.id, saleKey: r.sale_key, deviceRef: r.device_ref, deviceTime: r.device_time, receivedAt: r.received_at, total: Number(r.total), status: r.status, flags: r.flags, reason: r.reason, orderNumber: r.order_number, cashier: r.cashier ?? '' }));
  }

  /** Sales parked or refused in a shift: it cannot be closed while any are parked (a person puts the stock right or gives the sale up). */
  async parkedIn(shiftId: string): Promise<number> {
    const [row] = await this.db.select({ n: sql<string>`COUNT(*)::text` }).from(offlineSales).where(and(eq(offlineSales.shiftId, shiftId), eq(offlineSales.status, 'parked')));
    return Number(row?.n ?? 0);
  }

  /** Tries a parked sale again (after the stock was put right): it is made as the shift's owner, from what was received. */
  async retryParked(companyId: string, id: string): Promise<IngestResult> {
    const [row] = await this.db.select().from(offlineSales).where(and(eq(offlineSales.id, id), eq(offlineSales.companyId, companyId))).limit(1);
    if (row === undefined) return { ok: false, error: 'That sale could not be found.' };
    if (row.status !== 'parked') return { ok: false, error: 'Only a parked sale can be tried again.' };
    const [shift] = await this.db.select().from(shifts).where(eq(shifts.id, row.shiftId)).limit(1);
    if (shift === undefined) return { ok: false, error: 'The shift of this sale could not be found.' };
    const read = parseOfflineSale(row.payload);
    if (!read.ok) return { ok: false, error: read.error };
    return await this.make(companyId, shift.openedBy, read.sale, row.flags);
  }

  /** Gives a parked or refused sale up, with a reason that is kept: the sale is not in the books and the goods are accounted for another way. */
  async discard(companyId: string, actor: Actor, id: string, reason: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const text = reason.trim();
    if (text.length < 3 || text.length > 200) return { ok: false, error: 'Say why, in 3 to 200 characters.' };
    const [row] = await this.db.select().from(offlineSales).where(and(eq(offlineSales.id, id), eq(offlineSales.companyId, companyId))).limit(1);
    if (row === undefined) return { ok: false, error: 'That sale could not be found.' };
    if (row.status !== 'parked' && row.status !== 'rejected') return { ok: false, error: 'Only a parked or refused sale can be given up.' };
    await this.db.transaction(async (tx) => {
      await tx.update(offlineSales).set({ status: 'discarded', reason: `Given up: ${text}`, updatedAt: new Date() }).where(eq(offlineSales.id, id));
      await this.decisions.record({ companyId, actor, subject: { type: 'offline_sale', id: row.saleKey }, action: 'offline_sale.discarded', outcome: { was: row.status, reason: text, total: Number(row.total), deviceRef: row.deviceRef } }, tx);
    });
    return { ok: true };
  }

  /** A sale accepted with a difference has been looked at: it leaves the review list. */
  async acknowledge(companyId: string, actor: Actor, id: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const [row] = await this.db.select().from(offlineSales).where(and(eq(offlineSales.id, id), eq(offlineSales.companyId, companyId))).limit(1);
    if (row?.status !== 'needs_review') return { ok: false, error: 'Only a sale that needs a look can be marked as looked at.' };
    await this.db.transaction(async (tx) => {
      await tx.update(offlineSales).set({ status: 'accepted', updatedAt: new Date() }).where(eq(offlineSales.id, id));
      await this.decisions.record({ companyId, actor, subject: { type: 'offline_sale', id: row.saleKey }, action: 'offline_sale.reviewed', outcome: { flags: row.flags } }, tx);
    });
    return { ok: true };
  }

  roomLeft(limits: OfflineLimits, soldSoFar: number): number {
    return offlineRoom(limits, soldSoFar);
  }
}
