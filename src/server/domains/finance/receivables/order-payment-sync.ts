import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { customerLedgerEntries, financeSettings, orders } from '@/server/db/drizzle/schema';
import { OrderStages } from '@/server/domains/orders/stages';
import { DEFAULT_CHEQUE_COUNTS, planPaymentMove, settledState, type ChequeCountsMode } from '@/lib/order-payment';
import type { OrderStatus } from '@/types/index';
import { toCents } from '../domain/receivables';
import type { Tx } from '../engine';
import type { FinanceContext } from '../errors';

import { has } from '@/lib/values';

export interface SyncCause {
  /** The document behind the change: a receipt, a wallet use, a credit note. */
  document: string;
  action: string;
}

interface Totals {
  orderId: string;
  /** What the order's invoices total, less credit notes raised against the same order (a return is not a payment). */
  payableCents: number;
  /** What payments have settled: receipts (cheques per the company's rule), wallet use, credit from other documents. */
  paidCents: number;
}

/**
 * Keeps an order's payment state in step with what the customer ledger shows settled. Money received is recorded in the ledger;
 * the order's payment state is a stage, so it moves only through the order stage writer, in the caller's transaction.
 *
 * Every route that settles an invoice (a receipt, the wallet, a credit note's excess) goes through the ledger's apply and un-apply,
 * which call this, so no route can be left out. A credit note raised against the order's own invoice reduces what is owed; it is not
 * a payment and never makes the order "paid". A cheque that has not cleared does not count when the company's rule is "when it clears".
 */
// A namespace of the one writer of this link, like OrderStages (eslint's no-extraneous-class does not suit it).
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class OrderPaymentSync {
  static async chequeRule(tx: Tx, companyId: string): Promise<ChequeCountsMode> {
    const [setting] = await tx.select({ mode: financeSettings.chequeCountsAsPaid }).from(financeSettings).where(eq(financeSettings.companyId, companyId));
    return setting?.mode ?? DEFAULT_CHEQUE_COUNTS;
  }

  /** The invoices a credit entry (a receipt) has ever been applied to. */
  static async invoicesTouchedBy(tx: Tx, companyId: string, creditEntryId: string): Promise<string[]> {
    const rows = await tx.execute<{ id: string }>(sql`
      SELECT DISTINCT d.ledger_entry_id AS id
        FROM customer_detailed_entries d
       WHERE d.company_id = ${companyId} AND d.applied_to_entry_id = ${creditEntryId}::uuid
         AND d.entry_type IN ('application', 'unapplication') AND d.ledger_entry_id <> ${creditEntryId}::uuid`);
    return rows.map((r) => r.id);
  }

  private static async totals(tx: Tx, companyId: string, orderIds: string[], mode: ChequeCountsMode): Promise<Totals[]> {
    // One statement for all orders: what is owed and what is settled per order, so the work does not grow per order.
    const result = await tx.execute<{ order_id: string; invoiced: string; reduced: string; paid: string }>(sql`
      SELECT inv.order_id,
             SUM(inv.amount)::text AS invoiced,
             COALESCE(SUM(s.reduced), 0)::text AS reduced,
             COALESCE(SUM(s.paid), 0)::text AS paid
        FROM customer_ledger_entries inv
        LEFT JOIN LATERAL (
          SELECT SUM(-d.amount) FILTER (WHERE c.document_type = 'credit_note' AND c.order_id = inv.order_id) AS reduced,
                 SUM(-d.amount) FILTER (
                   WHERE NOT (c.document_type = 'credit_note' AND c.order_id = inv.order_id)
                     AND NOT (${mode} = 'on_clearing' AND r.cheque_status IS NOT NULL AND r.cheque_status <> 'cleared')
                 ) AS paid
            FROM customer_detailed_entries d
            JOIN customer_ledger_entries c ON c.id = d.applied_to_entry_id
            LEFT JOIN customer_receipts r ON r.ledger_entry_id = c.id
           WHERE d.ledger_entry_id = inv.id AND d.entry_type IN ('application', 'unapplication')
        ) s ON true
       WHERE inv.company_id = ${companyId}
         AND inv.document_type = 'invoice'
         AND inv.order_id IN (${sql.join(orderIds.map((id) => sql`${id}`), sql`, `)})
       GROUP BY inv.order_id`);
    return result.map((r) => ({ orderId: r.order_id, payableCents: toCents(r.invoiced) - toCents(r.reduced), paidCents: toCents(r.paid) }));
  }

  /**
   * Brings the orders behind these ledger entries (invoices; other entries are ignored) to the payment state the ledger now shows.
   * `release: false` (the backfill of history) never lets a payment change the order's fulfilment status. Returns the orders moved.
   */
  static async syncIn(
    tx: Tx,
    ctx: FinanceContext,
    entryIds: string[],
    cause: SyncCause,
    opts: { release?: boolean; mode?: ChequeCountsMode } = {},
  ): Promise<string[]> {
    if (entryIds.length === 0) return [];
    const touched = await tx
      .selectDistinct({ orderId: customerLedgerEntries.orderId })
      .from(customerLedgerEntries)
      .where(and(eq(customerLedgerEntries.companyId, ctx.companyId), inArray(customerLedgerEntries.id, entryIds), eq(customerLedgerEntries.documentType, 'invoice')));
    const orderIds = touched.map((t) => t.orderId).filter(has).sort();
    if (orderIds.length === 0) return [];
    const mode = opts.mode ?? (await OrderPaymentSync.chequeRule(tx, ctx.companyId));
    const totals = await OrderPaymentSync.totals(tx, ctx.companyId, orderIds, mode);
    const current = await tx
      .select({ id: orders.id, status: orders.status, paymentStatus: orders.paymentStatus, approvalStatus: orders.approvalStatus })
      .from(orders)
      .where(inArray(orders.id, totals.map((t) => t.orderId)));
    const byId = new Map(current.map((o) => [o.id, o]));

    const moved: string[] = [];
    for (const t of totals) {
      const order = byId.get(t.orderId);
      // An order whose invoices are fully credited has nothing left to pay: it is not decided here (its refund or cancellation is).
      const target = settledState(t.payableCents, t.paidCents);
      if (order === undefined || target === null) continue;
      const move = planPaymentMove(order.paymentStatus, target);
      if (move === null) continue;
      // Paying an invoice must not send an order back: only an order still waiting (and not held for approval) is released by its payment.
      const held = ['pending', 'rejected', 'draft'].includes(order.approvalStatus);
      const keepStatus = opts.release === false || move.stage !== 'payment_confirmed' || order.status !== 'pending' || held;
      const res = await OrderStages.moveIn(tx, order.id, move.stage, 'succeeded', {
        source: 'staff',
        actor: { type: ctx.actor.type === 'user' ? 'user' : 'system', id: ctx.actor.id },
        set: { paymentStatus: move.paymentStatus, ...(keepStatus ? { status: order.status as OrderStatus } : {}) },
        detail: { document: cause.document, action: cause.action, payable: t.payableCents / 100, paid: t.paidCents / 100, chequeRule: mode },
      });
      if (res.recorded) moved.push(order.id);
    }
    return moved;
  }

  /**
   * One page of the re-check of existing data: every invoice with money applied to it, in id order after `after`. `onlyCheques`
   * narrows it to invoices a cheque was applied to (what changing the cheque rule can affect). Returns the last id and what moved.
   */
  static async recheckPageIn(
    tx: Tx,
    ctx: FinanceContext,
    page: { after: string | null; limit: number; onlyCheques: boolean },
    cause: SyncCause,
  ): Promise<{ last: string | null; checked: number; moved: number }> {
    const rows = await tx
      .select({ id: customerLedgerEntries.id })
      .from(customerLedgerEntries)
      .where(
        and(
          eq(customerLedgerEntries.companyId, ctx.companyId),
          eq(customerLedgerEntries.documentType, 'invoice'),
          sql`${customerLedgerEntries.orderId} IS NOT NULL`,
          page.after === null ? undefined : gt(customerLedgerEntries.id, page.after),
          sql`EXISTS (SELECT 1 FROM customer_detailed_entries d ${page.onlyCheques ? sql`JOIN customer_receipts r ON r.ledger_entry_id = d.applied_to_entry_id AND r.cheque_status IS NOT NULL` : sql``}
               WHERE d.ledger_entry_id = ${customerLedgerEntries.id} AND d.entry_type IN ('application', 'unapplication'))`,
        ),
      )
      .orderBy(asc(customerLedgerEntries.id))
      .limit(page.limit);
    if (rows.length === 0) return { last: null, checked: 0, moved: 0 };
    const moved = await OrderPaymentSync.syncIn(tx, ctx, rows.map((r) => r.id), cause, { release: false });
    return { last: rows[rows.length - 1]?.id ?? null, checked: rows.length, moved: moved.length };
  }

  /**
   * Re-checks existing orders against the ledger, a page at a time (each page its own short transaction, so it never holds locks for
   * long and can be run again safely: an order already in step is not touched). Used to bring history in step after this feature
   * was added, and after the cheque rule changes.
   */
  static async recheckAll(db: DrizzleDb, ctx: FinanceContext, opts: { onlyCheques: boolean; action: string; limit?: number }): Promise<{ checked: number; moved: number }> {
    let after: string | null = null;
    let checked = 0;
    let moved = 0;
    for (;;) {
      const cursor: string | null = after;
      const page: { last: string | null; checked: number; moved: number } = await db.transaction((tx) => OrderPaymentSync.recheckPageIn(tx, ctx, { after: cursor, limit: opts.limit ?? 200, onlyCheques: opts.onlyCheques }, { document: 'recheck', action: opts.action }));
      checked += page.checked;
      moved += page.moved;
      if (page.last === null) return { checked, moved };
      after = page.last;
    }
  }
}
