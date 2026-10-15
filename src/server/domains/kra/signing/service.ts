import { and, desc, eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  branches,
  creditNoteLines,
  creditNotes,
  customerLedgerEntries,
  customers,
  kraSigningEvents,
  orderItems,
  orders,
  salesQuotes,
  type KraSigningEventRow,
} from '@/server/db/drizzle/schema';
import { KraConfigError } from '../types';
import { EtimsApiError } from '../etims/client';
import { EtimsItemError, type EtimsItemService } from '../etims/item-service';
import type { EtimsTransmissionService } from '../etims/transmission-service';
import {
  decideCreditNote,
  type FrozenInvoiceLine,
  type OriginalInvoiceState,
} from './credit-note-policy';
import type { KraSigningPolicy } from './policy';
import {
  SIGNING_DOCUMENT_TYPES,
  isSigningModule,
  type KraDocumentStatus,
  type LoggedDocumentType,
  type SigningDecision,
  type SigningDocumentType,
  type SigningModule,
  type SigningOutcome,
  type SigningReason,
  type SigningSourceKind,
} from './types';

import { has, trimToNull } from '@/lib/values';

/** What is sent to KRA for a document. Built only once the policy has said "sign". */
export interface SignableInvoice {
  /** The invoice number printed on the document; KRA's trader invoice number. */
  traderInvoiceNo: string;
  currency: string;
  totalAmount: number;
  salesDate: Date;
  customerPin?: string;
  lines: { productId: string; qty: number; unitPrice: number; amount: number }[];
}

/**
 * Everything the signing service needs to know about a document, whatever produced it.
 * Orders, quotes and (later) POS sales each build one of these; none of them decide or
 * send anything themselves.
 */
export interface SignableDocument {
  source: { kind: SigningSourceKind; id: string; ref: string };
  companyId: string;
  /** The branch it is issued from; null when it is not tied to one. */
  branchId: string | null;
  module: SigningModule;
  documentType: SigningDocumentType;
  /** The customer's flag; null when there is no profile, which signs by default. */
  customerFlag: boolean | null;
  /** Called only if the document is going to be sent. Never called for a skip. */
  buildInvoice: () => Promise<SignableInvoice>;
  /**
   * Called with the document's final status so the source can mirror it on its own records.
   * This is the only way a status reaches those records.
   */
  onStatus?: (status: KraDocumentStatus) => Promise<void>;
}

export interface SigningResult {
  outcome: SigningOutcome;
  reason: SigningReason;
  decision: SigningDecision;
  transmissionId: string | null;
}

/**
 * The one place anything is signed with KRA. `processDocument` runs the policy, signs when
 * allowed, and records every step; the `process…` adapters below only translate a source
 * record (an order, a quote) into a `SignableDocument`.
 *
 * It never throws: a document that cannot be signed must never stop the sale it belongs to,
 * so every failure is captured as an event and returned instead.
 */
export class DocumentSigningService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly policy: KraSigningPolicy,
    private readonly items: EtimsItemService,
    private readonly transmissions: EtimsTransmissionService,
  ) {}

  /** Events for one document in the order they happened. */
  async trace(documentKey: string): Promise<KraSigningEventRow[]> {
    return await this.db
      .select()
      .from(kraSigningEvents)
      .where(eq(kraSigningEvents.documentKey, documentKey))
      .orderBy(kraSigningEvents.createdAt);
  }

  /** Most recent events across documents, for the signing log screen. */
  async recent(
    input: { limit?: number; outcome?: SigningOutcome } = {},
  ): Promise<KraSigningEventRow[]> {
    const where = input.outcome ? eq(kraSigningEvents.outcome, input.outcome) : undefined;
    return await this.db
      .select()
      .from(kraSigningEvents)
      .where(where)
      .orderBy(desc(kraSigningEvents.createdAt))
      .limit(Math.min(input.limit ?? 100, 500));
  }

  static documentKey(
    kind: SigningSourceKind,
    id: string,
    documentType: LoggedDocumentType,
  ): string {
    return `${kind}:${id}:${documentType}`;
  }

  // ── adapters ────────────────────────────────────────────────────────────

  /** A tax invoice or proforma issued from an order (ecommerce, sales order, credit sale…). */
  async processOrderDocument(input: {
    orderId: string;
    documentType: SigningDocumentType;
    invoiceNumber: string;
  }): Promise<SigningResult> {
    try {
      const [order] = await this.db
        .select()
        .from(orders)
        .where(eq(orders.id, input.orderId))
        .limit(1);
      if (!order) throw new Error(`Order ${input.orderId} not found`);
      const companyId = await this.companyIdFor(order.tradeCustomerId, order.branchId);

      return await this.processDocument({
        source: { kind: 'order', id: order.id, ref: order.orderNumber },
        companyId,
        branchId: order.branchId,
        module: isSigningModule(order.salesModule) ? order.salesModule : 'ecommerce',
        documentType: input.documentType,
        // No trade customer means no profile: the default is to sign.
        customerFlag: has(order.tradeCustomerId) ? order.transmitInvoicesToKra : null,
        buildInvoice: async () => {
          const lines = await this.db
            .select()
            .from(orderItems)
            .where(eq(orderItems.orderId, order.id));
          return {
            traderInvoiceNo: input.invoiceNumber,
            currency: order.currency,
            totalAmount: Number(order.totalAmount),
            salesDate: new Date(),
            customerPin: (await this.buyerPin(order.tradeCustomerId)) ?? undefined,
            lines: lines.map((l) => ({
              productId: l.productId,
              qty: l.quantity,
              unitPrice: Number(l.unitPrice),
              amount: Number(l.totalPrice),
            })),
          };
        },
        // The order and its ledger invoice entry mirror the outcome; nothing else writes it.
        onStatus: async (status) => {
          await this.db
            .update(orders)
            .set({ kraTransmissionStatus: status })
            .where(eq(orders.id, order.id));
          await this.db
            .update(customerLedgerEntries)
            .set({ kraTransmissionStatus: status })
            .where(
              and(
                eq(customerLedgerEntries.orderId, order.id),
                eq(customerLedgerEntries.documentType, 'invoice'),
              ),
            );
        },
      });
    } catch (error: unknown) {
      return this.unexpected(error);
    }
  }

  /**
   * A quote's proforma. It is never signed, but it goes through the same door so the log
   * shows it was considered and why it was not signed. A quote is signed only once it
   * becomes a sales order, which is a different document under the `sales_order` module.
   */
  async processQuoteProforma(quoteId: string): Promise<SigningResult> {
    try {
      const [quote] = await this.db
        .select({
          id: salesQuotes.id,
          companyId: salesQuotes.companyId,
          branchId: salesQuotes.branchId,
          quoteNumber: salesQuotes.quoteNumber,
        })
        .from(salesQuotes)
        .where(eq(salesQuotes.id, quoteId))
        .limit(1);
      if (!quote) throw new Error(`Quote ${quoteId} not found`);
      return await this.processDocument({
        source: { kind: 'quote', id: quote.id, ref: quote.quoteNumber },
        companyId: quote.companyId,
        branchId: quote.branchId,
        module: 'sales_order',
        documentType: 'proforma',
        customerFlag: null,
        buildInvoice: async () => {
          throw new Error('A proforma is never sent to KRA.');
        },
      });
    } catch (error: unknown) {
      return this.unexpected(error);
    }
  }

  // ── credit notes ────────────────────────────────────────────────────────

  /**
   * Signs a credit note according to the credit note policy: it follows its original
   * invoice (see `decideCreditNote`). Same guarantees as invoices: never throws, records
   * every step, a signed credit note is never re-sent, and the credit note's own status is
   * written only here.
   */
  async processCreditNote(creditNoteId: string): Promise<SigningResult> {
    try {
      const [cn] = await this.db
        .select()
        .from(creditNotes)
        .where(eq(creditNotes.id, creditNoteId))
        .limit(1);
      if (!cn) throw new Error(`Credit note ${creditNoteId} not found`);
      const lines = await this.db
        .select()
        .from(creditNoteLines)
        .where(eq(creditNoteLines.creditNoteId, cn.id));

      const ctx: EventContext = {
        companyId: cn.companyId,
        branchId: cn.branchId,
        documentKey: DocumentSigningService.documentKey('credit_note', cn.id, 'credit_note'),
        documentType: 'credit_note',
        documentId: cn.id,
        documentRef: cn.creditNoteNo,
        module: cn.module,
      };

      const last = await this.lastEvent(ctx.documentKey);
      if (last?.eventType === 'transmission' && last.outcome === 'sign') {
        return {
          outcome: 'sign',
          reason: 'SIGN',
          decision: last.payload.decision as SigningDecision,
          transmissionId: last.transmissionId,
        };
      }

      const original = await this.originalInvoiceState(cn.originalDocumentKey);
      const decision = decideCreditNote(original, { originalDocumentKey: cn.originalDocumentKey });
      await this.recordDecision(ctx, decision, last);
      if (decision.outcome === 'skip') {
        await this.setCreditNoteStatus(cn.id, 'skipped');
        return { outcome: 'skip', reason: decision.reason, decision, transmissionId: null };
      }
      if (decision.outcome === 'defer' || original.kind !== 'signed') {
        await this.setCreditNoteStatus(cn.id, 'deferred');
        return { outcome: 'defer', reason: decision.reason, decision, transmissionId: null };
      }

      try {
        const sent = original.lines;
        const sendLines = lines.map((l) => {
          const frozen = sent.find((s) => s.productId === l.productId);
          if (!frozen) {
            throw new EtimsItemError(
              'NOT_REGISTERED',
              `${l.description} was not on the signed invoice, so it cannot be credited at KRA.`,
            );
          }
          return {
            itemCode: frozen.itemCode,
            qty: l.quantity,
            unitPrice: Number(l.unitPrice),
            amount: Number(l.amount),
          };
        });
        const transmission = await this.transmissions.transmitCreditNote({
          companyId: cn.companyId,
          branchId: cn.branchId,
          orderId: cn.sourceKind === 'order' ? cn.sourceId : null,
          traderInvoiceNo: cn.creditNoteNo,
          salesDate: new Date(),
          currency: cn.currency,
          totalAmount: Number(cn.totalAmount),
          lines: sendLines,
          originalTraderInvoiceNo: original.traderInvoiceNo,
          original: { source: original.scope, branchId: original.branchId },
        });
        await this.record(ctx, {
          eventType: 'transmission',
          outcome: 'sign',
          reason: 'SIGN',
          decision,
          payload: {
            decision,
            traderInvoiceNo: cn.creditNoteNo,
            originalDocumentKey: cn.originalDocumentKey,
            originalTraderInvoiceNo: original.traderInvoiceNo,
            scuReceiptNo: transmission.scuReceiptNo,
            verificationUrl: transmission.verificationUrl,
            attempts: transmission.attempts,
          },
          transmissionId: transmission.id,
        });
        await this.setCreditNoteStatus(cn.id, 'transmitted');
        return { outcome: 'sign', reason: 'SIGN', decision, transmissionId: transmission.id };
      } catch (error: unknown) {
        const { reason, message, retryable } = classify(error);
        await this.record(ctx, {
          eventType: 'transmission',
          outcome: 'fail',
          reason,
          decision,
          payload: { decision, error: message, retryable },
          transmissionId: null,
        });
        await this.setCreditNoteStatus(cn.id, 'failed');
        return { outcome: 'fail', reason, decision, transmissionId: null };
      }
    } catch (error: unknown) {
      return this.unexpected(error);
    }
  }

  /** Works out what became of an invoice from its signing log: the credit note's input. */
  private async originalInvoiceState(documentKey: string): Promise<OriginalInvoiceState> {
    const last = await this.lastEvent(documentKey);
    if (!last) {
      return {
        kind: 'pending',
        detail: 'The original invoice has not been considered for signing yet.',
      };
    }
    if (last.eventType === 'transmission' && last.outcome === 'sign') {
      const p = last.payload as {
        traderInvoiceNo?: string;
        currency?: string;
        lines?: FrozenInvoiceLine[];
      };
      if (last.mode && last.scope && has(p.traderInvoiceNo) && p.lines) {
        return {
          kind: 'signed',
          scope: last.scope,
          // Branch scope: the branch whose own settings signed it. Company scope: none.
          branchId: last.scope === 'branch' ? last.branchId : null,
          mode: last.mode,
          traderInvoiceNo: p.traderInvoiceNo,
          transmissionId: last.transmissionId,
          currency: p.currency ?? 'KES',
          lines: p.lines,
        };
      }
      return {
        kind: 'pending',
        detail:
          'The original invoice was signed before its details were recorded for credit notes.',
      };
    }
    const decisionEvent =
      last.eventType === 'decision' ? last : await this.lastDecision(documentKey);
    if (decisionEvent?.outcome === 'skip') {
      return { kind: 'not_signed', reason: decisionEvent.reason };
    }
    return {
      kind: 'pending',
      detail:
        last.outcome === 'fail'
          ? 'Signing the original invoice failed; it has not been signed yet.'
          : 'The original invoice has not been signed yet.',
    };
  }

  private async setCreditNoteStatus(id: string, status: KraDocumentStatus): Promise<void> {
    await this.db
      .update(creditNotes)
      .set({ kraStatus: status, updatedAt: new Date() })
      .where(eq(creditNotes.id, id));
  }

  /**
   * Credit notes waiting on this invoice can be settled once it is signed (they sign) or
   * deliberately skipped (they skip). Runs in the background; never throws.
   */
  private releaseDeferred(originalDocumentKey: string): void {
    void (async () => {
      const waiting = await this.db
        .select({ id: creditNotes.id })
        .from(creditNotes)
        .where(
          and(
            eq(creditNotes.originalDocumentKey, originalDocumentKey),
            eq(creditNotes.kraStatus, 'deferred'),
          ),
        );
      for (const w of waiting) await this.processCreditNote(w.id);
    })().catch((error: unknown) =>
      console.error('[kra-signing] releasing deferred credit notes failed', error),
    );
  }

  // ── the one door ────────────────────────────────────────────────────────

  async processDocument(doc: SignableDocument): Promise<SigningResult> {
    try {
      return await this.run(doc);
    } catch (error: unknown) {
      return this.unexpected(error);
    }
  }

  private unexpected(error: unknown): SigningResult {
    // Last resort: even the bookkeeping failed. The sale is unaffected either way.
    console.error('[kra-signing] unexpected failure', error);
    const decision: SigningDecision = {
      outcome: 'fail',
      reason: 'UNEXPECTED_ERROR',
      scope: null,
      branchId: null,
      mode: null,
      gates: [],
      settings: {},
    };
    return { outcome: 'fail', reason: 'UNEXPECTED_ERROR', decision, transmissionId: null };
  }

  private async run(doc: SignableDocument): Promise<SigningResult> {
    // Backstop for callers that bypass the types (e.g. a credit note, which has its own flow).
    if (!SIGNING_DOCUMENT_TYPES.includes(doc.documentType)) {
      console.error('[kra-signing] refused unsupported document type', doc.documentType);
      const decision: SigningDecision = {
        outcome: 'fail',
        reason: 'UNSUPPORTED_DOCUMENT_TYPE',
        scope: null,
        branchId: null,
        mode: null,
        gates: [],
        settings: { documentType: doc.documentType },
      };
      return { outcome: 'fail', reason: decision.reason, decision, transmissionId: null };
    }

    const ctx: EventContext = {
      companyId: doc.companyId,
      branchId: doc.branchId,
      documentKey: DocumentSigningService.documentKey(
        doc.source.kind,
        doc.source.id,
        doc.documentType,
      ),
      documentType: doc.documentType,
      documentId: doc.source.id,
      documentRef: doc.source.ref,
      module: doc.module,
    };

    // A document already signed is never signed again, however often it is regenerated.
    const last = await this.lastEvent(ctx.documentKey);
    if (last?.eventType === 'transmission' && last.outcome === 'sign') {
      return {
        outcome: 'sign',
        reason: 'SIGN',
        decision: last.payload.decision as SigningDecision,
        transmissionId: last.transmissionId,
      };
    }

    const decision = await this.policy.decide({
      companyId: doc.companyId,
      branchId: doc.branchId,
      module: doc.module,
      documentType: doc.documentType,
      customerFlag: doc.customerFlag,
    });
    await this.recordDecision(ctx, decision, last);
    if (decision.outcome !== 'sign') {
      await this.mirror(doc, decision.outcome === 'skip' ? 'skipped' : 'failed');
      // A credit note waiting on this invoice can now be resolved: nothing to reverse.
      if (decision.outcome === 'skip' && doc.documentType === 'tax_invoice') {
        this.releaseDeferred(ctx.documentKey);
      }
      return { outcome: decision.outcome, reason: decision.reason, decision, transmissionId: null };
    }

    // Signing is allowed: attempt it. From here a failure is recorded, never thrown.
    if (decision.mode !== 'etims') {
      return await this.recordFailure(doc, ctx, decision, 'TIMS_SIGNING_UNAVAILABLE', {
        message: 'Signing with TIMS is not available yet; no invoice was sent to the control unit.',
      });
    }
    try {
      const invoice = await doc.buildInvoice();
      if (invoice.currency !== 'KES') {
        throw new Error(
          `Invoices in ${invoice.currency} cannot be signed yet: eTIMS needs an exchange rate to KES.`,
        );
      }
      const itemCodes = await this.items.requireItemCodesForInvoice({
        companyId: doc.companyId,
        branchId: doc.branchId,
        productIds: invoice.lines.map((l) => l.productId),
      });
      const transmission = await this.transmissions.transmitInvoice({
        companyId: doc.companyId,
        branchId: doc.branchId,
        orderId: doc.source.kind === 'order' ? doc.source.id : null,
        traderInvoiceNo: invoice.traderInvoiceNo,
        salesDate: invoice.salesDate,
        currency: invoice.currency,
        customerPin: invoice.customerPin,
        totalAmount: invoice.totalAmount,
        lines: invoice.lines.map((l) => ({
          itemCode: itemCodes.get(l.productId)!,
          qty: l.qty,
          unitPrice: l.unitPrice,
          amount: l.amount,
        })),
      });
      await this.record(ctx, {
        eventType: 'transmission',
        outcome: 'sign',
        reason: 'SIGN',
        decision,
        payload: {
          decision,
          traderInvoiceNo: invoice.traderInvoiceNo,
          scuReceiptNo: transmission.scuReceiptNo,
          verificationUrl: transmission.verificationUrl,
          attempts: transmission.attempts,
          // Frozen as sent, so a credit note can reverse exactly this later.
          currency: invoice.currency,
          lines: invoice.lines.map((l) => ({
            productId: l.productId,
            itemCode: itemCodes.get(l.productId)!,
            qty: l.qty,
            unitPrice: l.unitPrice,
            amount: l.amount,
          })),
        },
        transmissionId: transmission.id,
      });
      await this.mirror(doc, 'transmitted');
      if (doc.documentType === 'tax_invoice') this.releaseDeferred(ctx.documentKey);
      return { outcome: 'sign', reason: 'SIGN', decision, transmissionId: transmission.id };
    } catch (error: unknown) {
      const { reason, message, retryable } = classify(error);
      return await this.recordFailure(doc, ctx, decision, reason, { message, retryable });
    }
  }

  private async recordFailure(
    doc: SignableDocument,
    ctx: EventContext,
    decision: SigningDecision,
    reason: SigningReason,
    detail: { message: string; retryable?: boolean },
  ): Promise<SigningResult> {
    await this.record(ctx, {
      eventType: 'transmission',
      outcome: 'fail',
      reason,
      decision,
      payload: { decision, error: detail.message, retryable: detail.retryable ?? false },
      transmissionId: null,
    });
    await this.mirror(doc, 'failed');
    return { outcome: 'fail', reason, decision, transmissionId: null };
  }

  /**
   * Mirrors the status onto the source. Only a tax invoice has a KRA status: a proforma is
   * never sent, and must not overwrite the status of the invoice it precedes. A failure here
   * must not undo the signing record.
   */
  private async mirror(doc: SignableDocument, status: KraDocumentStatus): Promise<void> {
    if (doc.documentType !== 'tax_invoice') return;
    try {
      await doc.onStatus?.(status);
    } catch (error: unknown) {
      console.error('[kra-signing] could not mirror status', doc.source, error);
    }
  }

  /** Writes the decision unless it is identical to the one already on record. */
  private async recordDecision(
    ctx: EventContext,
    decision: SigningDecision,
    last: KraSigningEventRow | null,
  ): Promise<void> {
    const previous = await this.lastDecision(ctx.documentKey);
    const same =
      previous &&
      previous.outcome === decision.outcome &&
      previous.reason === decision.reason &&
      stable(previous.payload.gates) === stable(decision.gates) &&
      stable(previous.payload.settings) === stable(decision.settings);
    // A repeat of an unchanged decision adds nothing. A retry after a failed transmission is
    // still allowed to re-record, so the new attempt is visible in the flow.
    if (same === true && last?.eventType === 'decision') return;
    await this.record(ctx, {
      eventType: 'decision',
      outcome: decision.outcome,
      reason: decision.reason,
      decision,
      payload: { gates: decision.gates, settings: decision.settings },
      transmissionId: null,
    });
  }

  private async record(
    ctx: EventContext,
    e: {
      eventType: 'decision' | 'transmission';
      outcome: SigningOutcome;
      reason: SigningReason;
      decision: SigningDecision;
      payload: Record<string, unknown>;
      transmissionId: string | null;
    },
  ): Promise<void> {
    await this.db.insert(kraSigningEvents).values({
      companyId: ctx.companyId,
      branchId: ctx.branchId ?? null,
      documentKey: ctx.documentKey,
      documentType: ctx.documentType,
      documentId: ctx.documentId,
      documentRef: ctx.documentRef,
      module: ctx.module,
      eventType: e.eventType,
      outcome: e.outcome,
      reason: e.reason,
      scope: e.decision.scope,
      mode: e.decision.mode,
      payload: e.payload,
      transmissionId: e.transmissionId,
    });
  }

  private async lastEvent(documentKey: string): Promise<KraSigningEventRow | null> {
    const [row] = await this.db
      .select()
      .from(kraSigningEvents)
      .where(eq(kraSigningEvents.documentKey, documentKey))
      .orderBy(desc(kraSigningEvents.createdAt))
      .limit(1);
    return row ?? null;
  }

  private async lastDecision(documentKey: string): Promise<KraSigningEventRow | null> {
    const [row] = await this.db
      .select()
      .from(kraSigningEvents)
      .where(
        and(
          eq(kraSigningEvents.documentKey, documentKey),
          eq(kraSigningEvents.eventType, 'decision'),
        ),
      )
      .orderBy(desc(kraSigningEvents.createdAt))
      .limit(1);
    return row ?? null;
  }

  private async buyerPin(tradeCustomerId: string | null): Promise<string | null> {
    if (!has(tradeCustomerId)) return null;
    const [row] = await this.db
      .select({ pin: customers.buyerKraPin })
      .from(customers)
      .where(eq(customers.id, tradeCustomerId))
      .limit(1);
    return trimToNull(row?.pin);
  }

  /** The company that owns the sale: through its customer, else through its branch. */
  private async companyIdFor(
    tradeCustomerId: string | null,
    branchId: string | null,
  ): Promise<string> {
    if (has(tradeCustomerId)) {
      const [row] = await this.db
        .select({ companyId: customers.companyId })
        .from(customers)
        .where(eq(customers.id, tradeCustomerId))
        .limit(1);
      if (row) return row.companyId;
    }
    if (has(branchId)) {
      const [row] = await this.db
        .select({ companyId: branches.companyId })
        .from(branches)
        .where(eq(branches.id, branchId))
        .limit(1);
      if (row) return row.companyId;
    }
    throw new Error('Cannot tell which company this order belongs to.');
  }
}

interface EventContext {
  companyId: string;
  branchId: string | null;
  documentKey: string;
  documentType: LoggedDocumentType;
  documentId: string;
  documentRef: string;
  module: SigningModule;
}

/** JSON with sorted keys: Postgres jsonb does not keep key order, so plain stringify can't compare. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
}

function classify(error: unknown): { reason: SigningReason; message: string; retryable: boolean } {
  if (error instanceof KraConfigError) {
    return {
      reason: error.code === 'MODE_MISMATCH' ? 'MODE_MISMATCH' : error.code,
      message: error.message,
      retryable: false,
    };
  }
  if (error instanceof EtimsItemError) {
    return { reason: 'ITEMS_NOT_REGISTERED', message: error.message, retryable: false };
  }
  if (error instanceof EtimsApiError) {
    return { reason: 'TRANSMISSION_FAILED', message: error.message, retryable: error.retryable };
  }
  return {
    reason: 'UNEXPECTED_ERROR',
    message: error instanceof Error ? error.message : 'Unknown error',
    retryable: false,
  };
}
