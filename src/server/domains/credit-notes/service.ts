import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  creditNoteLines,
  creditNotes,
  customers,
  branches,
  inventoryMovements,
  invoiceDocuments,
  orderItems,
  orders,
  type CreditNoteLineRow,
  type CreditNoteRow,
} from '@/server/db/drizzle/schema';
import { applyStockDelta, type Tx } from '@/server/domains/inventory/service';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { afterCommit } from '@/server/kernel/after-commit';
import type { NumberSeriesService } from '@/server/kernel/numbering/service';
import type { DocumentSigningService } from '@/server/domains/kra/signing/service';
import { CREDIT_NOTE_REASONS, type CreditNoteReason } from './reasons';
import { isSigningModule, type SigningModule } from '@/server/domains/kra/signing/types';

export { CREDIT_NOTE_REASONS, type CreditNoteReason };

export class CreditNoteError extends Error {
  constructor(
    readonly code:
      | 'NOT_A_TAX_INVOICE'
      | 'NO_LINES'
      | 'INVALID_LINE'
      | 'INVALID_REASON'
      | 'OVER_CREDIT'
      | 'NOT_FOUND'
      | 'NO_TAX_INVOICE'
      | 'RESTOCK_NOT_APPLICABLE',
    message: string,
  ) {
    super(message);
    this.name = 'CreditNoteError';
  }
}

/** A line of the original invoice as it was sold. */
export interface SoldLine {
  productId: string;
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

export interface IssueCreditNoteInput {
  companyId: string;
  /** The branch the original invoice was issued from. */
  branchId: string | null;
  module: SigningModule;
  /** The record the credit note belongs to, e.g. the order. */
  source: { kind: string; id: string; ref: string };
  original: {
    /** Signing-log key of the tax invoice, e.g. "order:ord_1:tax_invoice". */
    documentKey: string;
    currency: string;
    totalAmount: number;
    soldLines: SoldLine[];
  };
  lines: { productId: string; quantity: number }[];
  reason: { code: CreditNoteReason; note?: string };
  issuedBy: string;
  /**
   * The module's own business effects (restock, ledger, refund…). Runs in the same database
   * transaction as the credit note: if it throws, no credit note is created. Signing is
   * different — it happens afterwards and can never undo or block any of this.
   */
  effects?: (tx: Tx, creditNote: CreditNoteRow, lines: CreditNoteLineRow[]) => Promise<void>;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The one place a credit note is created, whatever module the sale came from. It validates
 * the credit against the original invoice, records it with the module's side effects in one
 * transaction, and then hands it to the signing service, which decides and signs under the
 * credit note policy. A signing failure never affects the credit note or its effects.
 */
export class CreditNoteService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly signing: DocumentSigningService,
    private readonly numbering: NumberSeriesService,
  ) {}

  /**
   * Pass `outer` to issue inside a transaction you already hold (an approval releasing it): the
   * credit note then commits or rolls back with it, and signing is queued for after that commit.
   */
  async issue(input: IssueCreditNoteInput, outer?: Tx): Promise<CreditNoteRow> {
    this.validateShape(input);
    const body = async (tx: Tx) => {
      // One credit at a time per original invoice, so the over-credit check cannot race.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.original.documentKey}))`);

      const previous = await tx
        .select({
          productId: creditNoteLines.productId,
          quantity: creditNoteLines.quantity,
          amount: creditNoteLines.amount,
        })
        .from(creditNoteLines)
        .innerJoin(creditNotes, eq(creditNotes.id, creditNoteLines.creditNoteId))
        .where(eq(creditNotes.originalDocumentKey, input.original.documentKey));
      const lines = this.priceLines(input, previous);
      const total = round2(lines.reduce((sum, l) => sum + l.amount, 0));
      const creditedBefore = round2(previous.reduce((sum, p) => sum + Number(p.amount), 0));
      if (total + creditedBefore > input.original.totalAmount + 0.005) {
        throw new CreditNoteError(
          'OVER_CREDIT',
          `This would credit ${(total + creditedBefore).toFixed(2)} against an invoice of ${input.original.totalAmount.toFixed(2)}.`,
        );
      }

      // Numbered by the credit note series inside this same transaction (it is a fiscal document,
      // so the series is gap-free): if anything below fails, the number is given back.
      const creditNoteId = randomUUID();
      const { number: creditNoteNo } = await this.numbering.assign(
        'credit_note',
        {
          companyId: input.companyId,
          branchId: input.branchId,
          date: businessDate(),
          document: { kind: 'credit_note', id: creditNoteId },
          actor: { type: 'user', id: input.issuedBy },
        },
        tx,
      );
      const [cn] = await tx
        .insert(creditNotes)
        .values({
          id: creditNoteId,
          companyId: input.companyId,
          branchId: input.branchId,
          module: input.module,
          sourceKind: input.source.kind,
          sourceId: input.source.id,
          sourceRef: input.source.ref,
          creditNoteNo,
          originalDocumentKey: input.original.documentKey,
          reasonCode: input.reason.code,
          reasonNote: input.reason.note?.trim() || null,
          currency: input.original.currency,
          totalAmount: total.toFixed(2),
          issuedBy: input.issuedBy,
        })
        .returning();
      const lineRows = await tx
        .insert(creditNoteLines)
        .values(
          lines.map((l) => ({
            creditNoteId: cn!.id,
            productId: l.productId,
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice.toFixed(2),
            amount: l.amount.toFixed(2),
          })),
        )
        .returning();
      await input.effects?.(tx, cn!, lineRows);
      return cn!;
    };

    // After commit: sign in the background. Whatever happens there, the credit note stands.
    const sign = (id: string) =>
      void this.signing
        .processCreditNote(id)
        .catch((error: unknown) => console.error('[credit-note] signing hook failed', error));

    if (outer) {
      const created = await body(outer);
      afterCommit(outer, () => sign(created.id));
      return created;
    }
    const created = await this.db.transaction(body);
    sign(created.id);
    return created;
  }

  /** Retries signing, e.g. after a gateway outage or a fixed configuration. */
  async retrySigning(creditNoteId: string) {
    const [cn] = await this.db
      .select()
      .from(creditNotes)
      .where(eq(creditNotes.id, creditNoteId))
      .limit(1);
    if (!cn) throw new CreditNoteError('NOT_FOUND', 'Credit note not found.');
    return this.signing.processCreditNote(cn.id);
  }

  async listForSource(kind: string, id: string): Promise<CreditNoteRow[]> {
    return this.db
      .select()
      .from(creditNotes)
      .where(and(eq(creditNotes.sourceKind, kind), eq(creditNotes.sourceId, id)))
      .orderBy(creditNotes.createdAt);
  }

  // ── order adapter ─────────────────────────────────────────────────────────

  /**
   * What can still be credited on an order's tax invoice, for the issue screen. Restock is
   * offered only if stock was actually taken for the order (it was fulfilled): otherwise the
   * units are still reserved, and adding them back would count them twice.
   */
  async creditableForOrder(orderId: string): Promise<{
    hasTaxInvoice: boolean;
    currency: string;
    invoiceTotal: number;
    creditedTotal: number;
    canRestock: boolean;
    lines: {
      productId: string;
      description: string;
      unitPrice: number;
      soldQuantity: number;
      creditedQuantity: number;
      remainingQuantity: number;
      remainingAmount: number;
    }[];
  }> {
    const [order] = await this.db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) throw new CreditNoteError('NOT_FOUND', `Order ${orderId} not found.`);
    const [taxInvoice] = await this.db
      .select({ id: invoiceDocuments.id })
      .from(invoiceDocuments)
      .where(
        and(
          eq(invoiceDocuments.orderId, order.id),
          eq(invoiceDocuments.documentType, 'tax_invoice'),
        ),
      )
      .limit(1);
    const items = await this.db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
    const credited = await this.db
      .select({
        productId: creditNoteLines.productId,
        quantity: creditNoteLines.quantity,
        amount: creditNoteLines.amount,
      })
      .from(creditNoteLines)
      .innerJoin(creditNotes, eq(creditNotes.id, creditNoteLines.creditNoteId))
      .where(eq(creditNotes.originalDocumentKey, `order:${order.id}:tax_invoice`));
    return {
      hasTaxInvoice: Boolean(taxInvoice),
      currency: order.currency,
      invoiceTotal: Number(order.totalAmount),
      creditedTotal: round2(credited.reduce((s, c) => s + Number(c.amount), 0)),
      canRestock: await this.stockWasTaken(order.id),
      lines: items.map((i) => {
        const mine = credited.filter((c) => c.productId === i.productId);
        const creditedQuantity = mine.reduce((s, c) => s + c.quantity, 0);
        return {
          productId: i.productId,
          description: i.productName,
          unitPrice: Number(i.unitPrice),
          soldQuantity: i.quantity,
          creditedQuantity,
          remainingQuantity: i.quantity - creditedQuantity,
          remainingAmount: round2(
            Number(i.totalPrice) - mine.reduce((s, c) => s + Number(c.amount), 0),
          ),
        };
      }),
    };
  }

  /** True once the order's reservation was settled as a fulfilment, i.e. stock really left. */
  private async stockWasTaken(orderId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: inventoryMovements.id })
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.referenceId, orderId),
          eq(inventoryMovements.changeType, 'order_fulfillment'),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Credit note against an order's tax invoice. Business effect implemented here: optional
   * restock of the credited units. Ledger reversal and refunds are not done by this
   * adapter; they need accounting rules that have not been defined.
   */
  async issueForOrder(
    input: {
      orderId: string;
      lines: { productId: string; quantity: number }[];
      reason: { code: CreditNoteReason; note?: string };
      issuedBy: string;
      /** Put the credited units back into stock. */
      restock?: boolean;
    },
    outer?: Tx,
  ): Promise<CreditNoteRow> {
    const [order] = await this.db
      .select()
      .from(orders)
      .where(eq(orders.id, input.orderId))
      .limit(1);
    if (!order) throw new CreditNoteError('NOT_FOUND', `Order ${input.orderId} not found.`);
    const [taxInvoice] = await this.db
      .select({ id: invoiceDocuments.id })
      .from(invoiceDocuments)
      .where(
        and(
          eq(invoiceDocuments.orderId, order.id),
          eq(invoiceDocuments.documentType, 'tax_invoice'),
        ),
      )
      .limit(1);
    if (!taxInvoice) {
      throw new CreditNoteError(
        'NO_TAX_INVOICE',
        'A credit note needs a tax invoice. No tax invoice has been issued for this order.',
      );
    }
    if (input.restock && !(await this.stockWasTaken(order.id))) {
      throw new CreditNoteError(
        'RESTOCK_NOT_APPLICABLE',
        'This order was never fulfilled, so no stock was taken for it. Cancel the order to release its reserved stock instead of restocking.',
      );
    }
    const items = await this.db.select().from(orderItems).where(eq(orderItems.orderId, order.id));

    return this.issue(
      {
        companyId: await this.companyIdFor(order.tradeCustomerId, order.branchId),
        branchId: order.branchId,
        module: isSigningModule(order.salesModule) ? order.salesModule : 'ecommerce',
        source: { kind: 'order', id: order.id, ref: order.orderNumber },
        original: {
          documentKey: `order:${order.id}:tax_invoice`,
          currency: order.currency,
          totalAmount: Number(order.totalAmount),
          soldLines: items.map((i) => ({
            productId: i.productId,
            description: i.productName,
            quantity: i.quantity,
            unitPrice: Number(i.unitPrice),
            amount: Number(i.totalPrice),
          })),
        },
        lines: input.lines,
        reason: input.reason,
        issuedBy: input.issuedBy,
        effects: async (tx, cn, lines) => {
          if (input.restock) {
            for (const l of lines) {
              await applyStockDelta(tx, {
                productId: l.productId,
                delta: l.quantity,
                allowDeleted: true,
                changeType: 'credit_note_restock',
                referenceId: cn.id,
                actor: input.issuedBy,
                note: `Credit note ${cn.creditNoteNo}: returned to stock.`,
              });
            }
          }
          // What was returned stops counting towards the customer's rebates and loyalty points.
          // A line's tax is not kept on the order, so its net is the order's net share of its gross.
          const goods = Number(order.subtotal) + Number(order.tax);
          const netShare = goods > 0 ? Number(order.subtotal) / goods : 1;
          const { getContainer } = await import('@/server/di/container');
          const { rebates, loyalty } = getContainer();
          await rebates.accrueCredit(
            tx,
            { companyId: cn.companyId, orderId: order.id, creditNoteId: cn.id },
            lines.map((l) => ({ productId: l.productId, net: Number(l.amount) * netShare })),
          );
          if (Number(order.subtotal) > 0)
            await loyalty.clawbackCredit(tx, {
              orderId: order.id,
              creditNoteNo: cn.creditNoteNo,
              fraction:
                (lines.reduce((n, l) => n + Number(l.amount), 0) * netShare) /
                Number(order.subtotal),
            });
        },
      },
      outer,
    );
  }

  /**
   * Issues the credit note, or parks it for approval when a workflow says a credit like this needs
   * one (it is then issued, in the approver's transaction, when the last approval is given). With
   * no workflow configured it is issued straight away, exactly as before.
   */
  async issueForOrderGated(
    request: Parameters<CreditNoteService['issueForOrder']>[0],
  ): Promise<
    | { status: 'issued'; creditNote: CreditNoteRow }
    | { status: 'pending_approval'; message: string }
  > {
    const { getContainer } = await import('@/server/di/container');
    const preview = await this.previewForOrder(request.orderId, request.lines);
    const outcome = await getContainer().approvalGate.gate(
      {
        trigger: 'credit_note.requested',
        companyId: preview.companyId,
        branchId: preview.branchId,
        requestedBy: request.issuedBy,
        amount: preview.amount,
        facts: { reasonCode: request.reason.code, isFullReturn: preview.isFullReturn },
        action: 'order_credit_note',
        payload: request as unknown as Record<string, unknown>,
        summary: `Issue a credit note of KES ${preview.amount.toLocaleString('en-KE')} against order ${preview.orderNumber} (${request.reason.code.replace(/_/g, ' ')}${request.restock ? ', returned to stock' : ''}).`,
      },
      () => this.issueForOrder(request),
    );
    if (outcome.parked) return { status: 'pending_approval', message: outcome.message };
    return { status: 'issued', creditNote: outcome.value };
  }

  /**
   * What an order credit would be worth and who it belongs to, for deciding whether it needs
   * approval. Reads only; the real credit is still checked in full when it is issued.
   */
  async previewForOrder(
    orderId: string,
    lines: { productId: string; quantity: number }[],
  ): Promise<{
    companyId: string;
    branchId: string | null;
    orderNumber: string;
    amount: number;
    isFullReturn: boolean;
  }> {
    const [order] = await this.db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) throw new CreditNoteError('NOT_FOUND', `Order ${orderId} not found.`);
    const view = await this.creditableForOrder(orderId);
    let amount = 0;
    for (const l of lines) {
      const sold = view.lines.find((x) => x.productId === l.productId);
      if (!sold) continue;
      const qty = Math.min(l.quantity, sold.remainingQuantity);
      amount +=
        qty === sold.remainingQuantity ? sold.remainingAmount : round2(sold.unitPrice * qty);
    }
    amount = round2(amount);
    return {
      companyId: await this.companyIdFor(order.tradeCustomerId, order.branchId),
      branchId: order.branchId,
      orderNumber: order.orderNumber,
      amount,
      isFullReturn:
        view.invoiceTotal > 0 && Math.abs(view.creditedTotal + amount - view.invoiceTotal) < 0.005,
    };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private validateShape(input: IssueCreditNoteInput): void {
    if (!input.original.documentKey.endsWith(':tax_invoice')) {
      throw new CreditNoteError(
        'NOT_A_TAX_INVOICE',
        'A credit note can only be raised against a tax invoice, never a proforma.',
      );
    }
    if (!CREDIT_NOTE_REASONS.includes(input.reason.code)) {
      throw new CreditNoteError('INVALID_REASON', 'Choose a valid reason for the credit note.');
    }
    if (input.lines.length === 0) {
      throw new CreditNoteError('NO_LINES', 'A credit note needs at least one line.');
    }
    const seen = new Set<string>();
    for (const l of input.lines) {
      if (!Number.isInteger(l.quantity) || l.quantity <= 0) {
        throw new CreditNoteError(
          'INVALID_LINE',
          'Each quantity must be a whole number above zero.',
        );
      }
      if (seen.has(l.productId)) {
        throw new CreditNoteError('INVALID_LINE', 'List each product once.');
      }
      seen.add(l.productId);
    }
  }

  /**
   * Prices each credited line at the original's price and checks it against what is still
   * creditable: per product, quantity and amount across all earlier credit notes.
   */
  private priceLines(
    input: IssueCreditNoteInput,
    previous: { productId: string; quantity: number; amount: string }[],
  ) {
    return input.lines.map((l) => {
      const sold = input.original.soldLines.find((s) => s.productId === l.productId);
      if (!sold) {
        throw new CreditNoteError('INVALID_LINE', 'That product is not on the original invoice.');
      }
      const priorQty = previous
        .filter((p) => p.productId === l.productId)
        .reduce((n, p) => n + p.quantity, 0);
      const priorAmount = previous
        .filter((p) => p.productId === l.productId)
        .reduce((n, p) => n + Number(p.amount), 0);
      if (priorQty + l.quantity > sold.quantity) {
        throw new CreditNoteError(
          'OVER_CREDIT',
          `${sold.description}: ${sold.quantity} sold, ${priorQty} already credited, cannot credit ${l.quantity} more.`,
        );
      }
      // The final unit takes whatever is left, so rounding never leaves cents uncredited.
      const amount =
        priorQty + l.quantity === sold.quantity
          ? round2(sold.amount - priorAmount)
          : round2(sold.unitPrice * l.quantity);
      return {
        productId: l.productId,
        description: sold.description,
        quantity: l.quantity,
        unitPrice: sold.unitPrice,
        amount,
      };
    });
  }

  private async companyIdFor(
    tradeCustomerId: string | null,
    branchId: string | null,
  ): Promise<string> {
    if (tradeCustomerId) {
      const [row] = await this.db
        .select({ id: customers.companyId })
        .from(customers)
        .where(eq(customers.id, tradeCustomerId))
        .limit(1);
      if (row) return row.id;
    }
    if (branchId) {
      const [row] = await this.db
        .select({ id: branches.companyId })
        .from(branches)
        .where(eq(branches.id, branchId))
        .limit(1);
      if (row) return row.id;
    }
    throw new CreditNoteError('NOT_FOUND', 'Cannot tell which company this order belongs to.');
  }
}
