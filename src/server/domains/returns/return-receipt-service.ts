import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  creditNoteLines,
  creditNotes,
  orderItems,
  returnReceiptConfirmations,
  returnReceiptLines,
  returnReceipts,
  type CreditNoteLineRow,
  type CreditNoteRow,
  type ReturnCondition,
  type ReturnDisposition,
  type ReturnReceiptRow,
} from '@/server/db/drizzle/schema';
import { checkDisposition } from '@/server/domains/finance/domain/credit-note-accounting';
import { applyStockDelta, type Tx } from '@/server/domains/inventory/service';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { businessDate } from '@/server/kernel/numbering/business-date';
import type { NumberSeriesService } from '@/server/kernel/numbering/service';
import type { ReasonCodes } from '@/server/kernel/reason-codes/service';

export class ReturnError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ReturnError';
  }
}

export interface ReturnActor {
  companyId: string;
  actorId: string;
  origin: { surface: string; action: string; permissionUsed?: string | null; ip?: string | null };
}

export interface ConfirmItem {
  lineId: string;
  quantity: number;
  condition: ReturnCondition;
  disposition: ReturnDisposition;
  note?: string | null;
}

const CONDITIONS: ReturnCondition[] = ['good', 'damaged', 'expired', 'wrong_item'];
const DISPOSITIONS: ReturnDisposition[] = ['return_to_stock', 'quarantine', 'scrap', 'return_to_supplier'];

/**
 * Goods coming back because of a credit note. A credit note can only ask for them; stock changes
 * when a person with the right permission confirms what actually arrived, how many, in what
 * condition and what was done with them. Each act of confirming is recorded and cannot be changed.
 */
export class ReturnReceiptService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly numbering: NumberSeriesService,
    private readonly reasons: ReasonCodes,
  ) {}

  /** Asks for the goods of a credit note back. Runs in the credit note's own transaction. */
  async requestIn(
    tx: Tx,
    p: { companyId: string; creditNote: CreditNoteRow; lines: CreditNoteLineRow[]; orderId: string; requestedBy: string },
  ): Promise<{ id: string; number: string }> {
    const { number } = await this.numbering.assign(
      'return_receipt',
      {
        companyId: p.companyId,
        branchId: p.creditNote.branchId,
        date: businessDate(),
        document: { kind: 'return_receipt', id: p.creditNote.id },
        actor: { type: 'user', id: p.requestedBy },
      },
      tx,
    );
    const [r] = await tx
      .insert(returnReceipts)
      .values({ companyId: p.companyId, number, creditNoteId: p.creditNote.id, orderId: p.orderId, branchId: p.creditNote.branchId, requestedBy: p.requestedBy })
      .returning();
    const costs = await tx.select({ productId: orderItems.productId, cost: orderItems.unitCost }).from(orderItems).where(eq(orderItems.orderId, p.orderId));
    const cost = new Map(costs.map((c) => [c.productId, c.cost]));
    await tx.insert(returnReceiptLines).values(
      p.lines.map((l) => ({ receiptId: r!.id, productId: l.productId, description: l.description, expectedQty: l.quantity, unitCost: cost.get(l.productId) ?? null })),
    );
    await this.decisions.record(
      { companyId: p.companyId, subject: { type: 'return_receipt', id: r!.id }, action: 'returns.requested', actor: { type: 'user', id: p.requestedBy }, to: 'awaiting_goods', inputs: { creditNote: p.creditNote.creditNoteNo }, outcome: { number, lines: p.lines.length } },
      tx,
    );
    return { id: r!.id, number };
  }

  async list(companyId: string, filter: 'open' | 'closed' = 'open', limit = 100) {
    return this.db
      .select({
        r: returnReceipts,
        creditNoteNo: creditNotes.creditNoteNo,
        sourceRef: creditNotes.sourceRef,
        reasonCode: creditNotes.reasonCode,
        expected: sql<number>`(SELECT COALESCE(SUM(l.expected_qty),0)::int FROM return_receipt_lines l WHERE l.receipt_id = ${returnReceipts.id})`,
        received: sql<number>`(SELECT COALESCE(SUM(l.received_qty),0)::int FROM return_receipt_lines l WHERE l.receipt_id = ${returnReceipts.id})`,
      })
      .from(returnReceipts)
      .innerJoin(creditNotes, eq(creditNotes.id, returnReceipts.creditNoteId))
      .where(
        and(
          eq(returnReceipts.companyId, companyId),
          filter === 'open' ? sql`${returnReceipts.closedAt} IS NULL` : sql`${returnReceipts.closedAt} IS NOT NULL`,
        ),
      )
      .orderBy(filter === 'open' ? asc(returnReceipts.createdAt) : desc(returnReceipts.closedAt))
      .limit(limit);
  }

  async detail(companyId: string, id: string) {
    const [head] = await this.db
      .select({ r: returnReceipts, creditNoteNo: creditNotes.creditNoteNo, sourceRef: creditNotes.sourceRef, reasonCode: creditNotes.reasonCode })
      .from(returnReceipts)
      .innerJoin(creditNotes, eq(creditNotes.id, returnReceipts.creditNoteId))
      .where(and(eq(returnReceipts.companyId, companyId), eq(returnReceipts.id, id)));
    if (!head) return null;
    const [lines, confirmations] = await Promise.all([
      this.db.select().from(returnReceiptLines).where(eq(returnReceiptLines.receiptId, id)).orderBy(asc(returnReceiptLines.createdAt), asc(returnReceiptLines.id)),
      this.db.select().from(returnReceiptConfirmations).where(eq(returnReceiptConfirmations.receiptId, id)).orderBy(asc(returnReceiptConfirmations.id)),
    ]);
    return { ...head, lines, confirmations };
  }

  async forCreditNotes(ids: string[]): Promise<Map<string, Pick<ReturnReceiptRow, 'id' | 'number' | 'status'>>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db.select({ id: returnReceipts.id, number: returnReceipts.number, status: returnReceipts.status, cn: returnReceipts.creditNoteId }).from(returnReceipts).where(sql`${returnReceipts.creditNoteId} IN (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})`);
    return new Map(rows.map((r) => [r.cn, { id: r.id, number: r.number, status: r.status }]));
  }

  /**
   * Confirms goods that arrived. Only good goods go back to stock, and only here is stock added.
   * Can be done in several goes until everything expected has been seen or the request is closed.
   */
  async confirm(a: ReturnActor, receiptId: string, items: ConfirmItem[]): Promise<{ status: ReturnReceiptRow['status']; stockAdded: number }> {
    if (items.length === 0) throw new ReturnError('NOTHING_TO_CONFIRM', 'Enter what arrived.');
    return this.db.transaction(async (tx) => {
      const [r] = await tx.select().from(returnReceipts).where(and(eq(returnReceipts.companyId, a.companyId), eq(returnReceipts.id, receiptId))).for('update');
      if (!r) throw new ReturnError('NOT_FOUND', 'That return does not exist.');
      if (r.closedAt || (r.status !== 'awaiting_goods' && r.status !== 'partially_confirmed')) {
        throw new ReturnError('CLOSED', `This return is ${r.status.replace('_', ' ')} and takes no more.`);
      }
      const lines = await tx.select().from(returnReceiptLines).where(eq(returnReceiptLines.receiptId, receiptId)).for('update');
      const byId = new Map(lines.map((l) => [l.id, l]));
      const seen = new Set<string>();
      let stockAdded = 0;
      for (const it of items) {
        const line = byId.get(it.lineId);
        if (!line) throw new ReturnError('LINE_NOT_FOUND', 'One of the lines is not on this return.');
        if (seen.has(it.lineId)) throw new ReturnError('DUPLICATE_LINE', 'Enter each line once.');
        seen.add(it.lineId);
        if (!Number.isInteger(it.quantity) || it.quantity <= 0) throw new ReturnError('QUANTITY_INVALID', `${line.description}: the quantity must be a whole number above zero.`);
        if (it.quantity > line.expectedQty - line.receivedQty) {
          throw new ReturnError('OVER_RECEIVED', `${line.description}: ${line.expectedQty - line.receivedQty} still expected, you entered ${it.quantity}.`);
        }
        if (!CONDITIONS.includes(it.condition) || !DISPOSITIONS.includes(it.disposition)) throw new ReturnError('INVALID', 'Choose the condition and what was done with the goods.');
        const bad = checkDisposition(it.condition, it.disposition);
        if (bad) throw new ReturnError('DISPOSITION_INVALID', `${line.description}: ${bad}`);
        const toStock = it.disposition === 'return_to_stock';
        if (toStock) {
          await applyStockDelta(tx, {
            productId: line.productId,
            delta: it.quantity,
            allowDeleted: true,
            changeType: 'credit_note_restock',
            referenceId: r.id,
            actor: a.actorId,
            note: `Return ${r.number}: ${it.quantity} confirmed back into stock.`,
          });
          stockAdded += it.quantity;
        }
        await tx.insert(returnReceiptConfirmations).values({
          receiptId,
          lineId: line.id,
          quantity: it.quantity,
          condition: it.condition,
          disposition: it.disposition,
          stockAdded: toStock,
          note: it.note?.trim() || null,
          confirmedBy: a.actorId,
          origin: a.origin,
        });
        await tx.update(returnReceiptLines).set({ receivedQty: sql`${returnReceiptLines.receivedQty} + ${it.quantity}` }).where(eq(returnReceiptLines.id, line.id));
      }
      const after = await tx.select().from(returnReceiptLines).where(eq(returnReceiptLines.receiptId, receiptId));
      const complete = after.every((l) => l.receivedQty === l.expectedQty);
      const status: ReturnReceiptRow['status'] = complete ? 'confirmed' : 'partially_confirmed';
      await tx.update(returnReceipts).set({ status, ...(complete ? { closedAt: new Date(), closedBy: a.actorId } : {}) }).where(eq(returnReceipts.id, receiptId));
      await this.decisions.record(
        { companyId: a.companyId, subject: { type: 'return_receipt', id: receiptId }, action: 'returns.confirmed', actor: { type: 'user', id: a.actorId }, from: r.status, to: status, inputs: { origin: a.origin }, outcome: { items: items.length, stockAdded } },
        tx,
      );
      return { status, stockAdded };
    });
  }

  /** The goods are not coming (or no more are): closes the rest with a reason. Nothing is added to stock. */
  async close(a: ReturnActor, receiptId: string, reason: { code: string; text?: string | null }): Promise<void> {
    const rs = await this.reasons.require(a.companyId, reason, 'return');
    await this.db.transaction(async (tx) => {
      const [r] = await tx.select().from(returnReceipts).where(and(eq(returnReceipts.companyId, a.companyId), eq(returnReceipts.id, receiptId))).for('update');
      if (!r) throw new ReturnError('NOT_FOUND', 'That return does not exist.');
      if (r.closedAt) throw new ReturnError('CLOSED', `This return is already ${r.status.replace('_', ' ')}.`);
      const lines = await tx.select({ n: sql<number>`COALESCE(SUM(${returnReceiptLines.receivedQty}),0)::int` }).from(returnReceiptLines).where(eq(returnReceiptLines.receiptId, receiptId));
      const status: ReturnReceiptRow['status'] = (lines[0]?.n ?? 0) > 0 ? 'partially_confirmed' : 'rejected';
      await tx.update(returnReceipts).set({ status, closedAt: new Date(), closedBy: a.actorId, closeReasonCode: rs.code, closeReasonText: rs.text }).where(eq(returnReceipts.id, receiptId));
      await this.decisions.record(
        { companyId: a.companyId, subject: { type: 'return_receipt', id: receiptId }, action: 'returns.closed', actor: { type: 'user', id: a.actorId }, from: r.status, to: status, reason: rs, inputs: { origin: a.origin } },
        tx,
      );
    });
  }

  async creditNoteLinesFor(creditNoteId: string) {
    return this.db.select().from(creditNoteLines).where(eq(creditNoteLines.creditNoteId, creditNoteId));
  }
}
