import { sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { decodeCursor, escapeLike } from '@/server/domains/lookups/request';
import { PAGE_SIZE, pageOf } from '@/server/domains/settings/paging';
import type { GeneratedInvoice, InvoiceDocumentType, InvoiceService } from '@/server/domains/invoices/service';
import { balanceOf, invoiceLine, partLine, type InvoiceLine } from './domain/invoice-figures';
import type { PriceTrace } from '@/server/domains/pricing/domain/types';
import { isListKind, paymentStateOf, signingStateOf, type PaymentState, type SigningState } from './domain/invoice-status';

export interface SalesInvoiceRow {
  invoiceNumber: string;
  kind: string;
  orderId: string;
  orderNumber: string;
  customerName: string;
  currency: string;
  total: number;
  credited: number;
  createdAt: string;
  emailed: boolean;
  signing: SigningState;
  payment: PaymentState;
  salesModule: string | null;
  /** For a part invoice: the part (billing) it is, so its document and credit notes are found. */
  billingId: string | null;
}

export interface SalesInvoiceDetail extends SalesInvoiceRow {
  customerEmail: string;
  orderStatus: string | null;
  approvalStatus: string | null;
  emailedAt: string | null;
  creditNotes: { number: string; total: number; currency: string; kraStatus: string; createdAt: string }[];
  signingLog: { eventType: string; outcome: string; reason: string; createdAt: string }[];
  lines: InvoiceLine[];
  /** The figures under the lines, for a whole-order invoice (a part invoice has only its lines and total). */
  figures: { subtotal: number; tax: number; delivery: number; discount: number } | null;
  /** What has been paid against it, and what is still owed; null for a part invoice, whose payments are not tracked per part. */
  paid: number | null;
  balance: number | null;
}

export type RaiseOutcome = { ok: true; invoiceNumber: string; orderNumber: string } | { ok: false; error: string };

interface RawRow extends Record<string, unknown> {
  id: string;
  invoice_number: string;
  document_type: string;
  order_id: string;
  order_number: string;
  customer_name: string;
  currency: string;
  total_amount: string;
  credited: string;
  key: string;
  emailed: boolean;
  payment_status: string | null;
  sales_module: string | null;
  signing_event: string | null;
  signing_outcome: string | null;
  billing_id: string | null;
}

const rowOf = (r: RawRow): SalesInvoiceRow => ({
  invoiceNumber: r.invoice_number,
  kind: r.document_type,
  orderId: r.order_id,
  orderNumber: r.order_number,
  customerName: r.customer_name,
  currency: r.currency,
  total: Number(r.total_amount),
  credited: Number(r.credited),
  createdAt: r.key,
  emailed: r.emailed,
  signing: signingStateOf(r.signing_event === null || r.signing_outcome === null ? null : { eventType: r.signing_event, outcome: r.signing_outcome }),
  payment: paymentStateOf(Number(r.total_amount), Number(r.credited), r.payment_status),
  salesModule: r.sales_module,
  billingId: r.billing_id,
});

/** The select every list and detail shares: the invoice with its order's payment state, what was credited against it and the latest signing event. */
const baseSelect = sql`
  SELECT d.id::text AS id, d.invoice_number, d.document_type, d.order_id, d.order_number, d.customer_name, d.currency, d.total_amount::text AS total_amount,
         d.created_at::text AS key, (d.emailed_at IS NOT NULL) AS emailed, o.payment_status, o.sales_module, d.meta->>'billingId' AS billing_id,
         COALESCE((SELECT SUM(cn.total_amount) FROM credit_notes cn WHERE cn.original_document_key = CASE WHEN d.document_type = 'tax_invoice_part' THEN 'order_billing:' || COALESCE(d.meta->>'billingId', '') || ':tax_invoice' ELSE 'order:' || d.order_id || ':' || d.document_type END), 0)::text AS credited,
         (SELECT e.event_type FROM kra_signing_events e WHERE e.document_key = CASE WHEN d.document_type = 'tax_invoice_part' THEN 'order_billing:' || COALESCE(d.meta->>'billingId', '') || ':tax_invoice' ELSE 'order:' || d.order_id || ':' || d.document_type END ORDER BY e.created_at DESC LIMIT 1) AS signing_event,
         (SELECT e.outcome FROM kra_signing_events e WHERE e.document_key = CASE WHEN d.document_type = 'tax_invoice_part' THEN 'order_billing:' || COALESCE(d.meta->>'billingId', '') || ':tax_invoice' ELSE 'order:' || d.order_id || ':' || d.document_type END ORDER BY e.created_at DESC LIMIT 1) AS signing_outcome
    FROM invoice_documents d LEFT JOIN orders o ON o.id = d.order_id`;

/** The invoice documents of the company's sales: found, shown with how each stands, raised for an order that has none, sent again and printed. */
export class SalesInvoiceService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly invoices: InvoiceService,
  ) {}

  /** Invoices newest first (25 a page), narrowed by words (invoice or order number, customer) or by kind. */
  async page(input: { query?: string; kind?: string; cursor?: string | null }): Promise<{ rows: SalesInvoiceRow[]; nextCursor: string | null }> {
    const query = (input.query ?? '').trim().slice(0, 100);
    const pattern = `%${escapeLike(query)}%`;
    const after = typeof input.cursor === 'string' && input.cursor !== '' ? decodeCursor(input.cursor) : null;
    const kind = isListKind(input.kind) ? input.kind : null;
    const found = await this.db.execute<RawRow>(sql`
      ${baseSelect}
      WHERE TRUE
        ${kind === null ? sql`` : sql`AND d.document_type = ${kind}`}
        ${query === '' ? sql`` : sql`AND (d.invoice_number ILIKE ${pattern} OR d.order_number ILIKE ${pattern} OR d.customer_name ILIKE ${pattern})`}
        ${after === null ? sql`` : sql`AND (d.created_at, d.id) < (${after.k}::timestamptz, ${after.id}::uuid)`}
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT ${PAGE_SIZE + 1}`);
    const page = pageOf(found, PAGE_SIZE, (r) => ({ k: r.key, id: r.id }));
    return { rows: page.rows.map(rowOf), nextCursor: page.nextCursor };
  }

  /** One invoice with what is behind it: the order, the credit notes against it, the signing log and its lines. */
  async detail(invoiceNumber: string): Promise<SalesInvoiceDetail | null> {
    const [raw] = await this.db.execute<RawRow & { customer_email: string; emailed_at: string | null; order_status: string | null; approval_status: string | null }>(sql`
      SELECT x.*, d2.customer_email, d2.emailed_at::text AS emailed_at, o2.status AS order_status, o2.approval_status
        FROM (${baseSelect} WHERE d.invoice_number = ${invoiceNumber}) x
        JOIN invoice_documents d2 ON d2.invoice_number = x.invoice_number
        LEFT JOIN orders o2 ON o2.id = x.order_id`);
    if (raw === undefined) return null;
    const key = raw.document_type === 'tax_invoice_part' ? `order_billing:${raw.billing_id ?? ''}:tax_invoice` : `order:${raw.order_id}:${raw.document_type}`;
    const whole = raw.document_type !== 'tax_invoice_part';
    // Only a tax invoice is something to be paid; a proforma or a delivery invoice shows its lines and no balance.
    const owed = raw.document_type === 'tax_invoice';
    const [notes, log, items, partLines, totals, settled] = await Promise.all([
      this.db.execute<{ credit_note_no: string; total_amount: string; currency: string; kra_status: string; created_at: string }>(sql`SELECT credit_note_no, total_amount::text, currency, kra_status, created_at::text FROM credit_notes WHERE original_document_key = ${key} ORDER BY created_at`),
      this.db.execute<{ event_type: string; outcome: string; reason: string; created_at: string }>(sql`SELECT event_type, outcome, reason, created_at::text FROM kra_signing_events WHERE document_key = ${key} ORDER BY created_at DESC LIMIT 20`),
      whole
        ? this.db.execute<{ product_name: string; sku: string; quantity: string; unit_code: string | null; unit_price: string; total_price: string; price_trace: PriceTrace | string | null; tax_rate: string | null }>(sql`SELECT i.product_name, i.sku, i.quantity::text, i.unit_code, i.unit_price::text, i.total_price::text, i.price_trace, p.tax_rate::text AS tax_rate FROM order_items i LEFT JOIN products p ON p.id = i.product_id WHERE i.order_id = ${raw.order_id} ORDER BY i.id`)
        : Promise.resolve([]),
      whole
        ? Promise.resolve([])
        : this.db.execute<{ description: string; quantity: string; amount: string }>(sql`SELECT description, quantity::text, amount::text AS amount FROM order_billing_lines WHERE billing_id = ${raw.billing_id ?? ''}::uuid ORDER BY id`),
      whole
        ? this.db.execute<{ subtotal: string; tax: string; shipping_fee: string }>(sql`SELECT subtotal::text, tax::text, shipping_fee::text FROM orders WHERE id = ${raw.order_id}`)
        : Promise.resolve([]),
      // What the customer's ledger shows settled against this order's invoice (receipts, wallet, credit from other documents; credit notes of the order itself are not payments).
      owed
        ? this.db.execute<{ paid: string }>(sql`
            SELECT COALESCE(SUM(-d.amount) FILTER (WHERE NOT (c.document_type = 'credit_note' AND c.order_id = inv.order_id)), 0)::text AS paid
              FROM customer_ledger_entries inv
              LEFT JOIN customer_detailed_entries d ON d.ledger_entry_id = inv.id AND d.entry_type IN ('application', 'unapplication')
              LEFT JOIN customer_ledger_entries c ON c.id = d.applied_to_entry_id
             WHERE inv.document_type = 'invoice' AND inv.order_id = ${raw.order_id}`)
        : Promise.resolve([]),
    ]);
    const row = rowOf(raw);
    const lines = whole
      ? items.map((l) => invoiceLine({ name: l.product_name, sku: l.sku, quantity: Number(l.quantity), unitCode: l.unit_code, unitPrice: Number(l.unit_price), total: Number(l.total_price), taxRate: l.tax_rate === null ? null : Number(l.tax_rate), trace: typeof l.price_trace === 'string' ? (JSON.parse(l.price_trace) as PriceTrace) : l.price_trace }))
      : partLines.map((l) => partLine({ name: l.description, quantity: Number(l.quantity), amount: Number(l.amount) }));
    const credited = notes.reduce((sum, n) => sum + Number(n.total_amount), 0);
    // An order the shop already records as paid (a card or M-Pesa payment at checkout) is paid in full whatever the ledger says.
    const ledgerPaid = Number(settled[0]?.paid ?? 0);
    const settledInFull = row.payment === 'paid' ? Math.max(ledgerPaid, Math.max(0, row.total - credited)) : ledgerPaid;
    const paid = owed ? settledInFull : null;
    const figures = whole && totals[0] !== undefined ? { subtotal: Number(totals[0].subtotal), tax: Number(totals[0].tax), delivery: Number(totals[0].shipping_fee), discount: lines.reduce((sum, l) => sum + l.discount, 0) } : null;
    return {
      ...row,
      customerEmail: raw.customer_email,
      orderStatus: raw.order_status,
      approvalStatus: raw.approval_status,
      emailedAt: raw.emailed_at,
      creditNotes: notes.map((n) => ({ number: n.credit_note_no, total: Number(n.total_amount), currency: n.currency, kraStatus: n.kra_status, createdAt: n.created_at })),
      signingLog: log.map((e) => ({ eventType: e.event_type, outcome: e.outcome, reason: e.reason, createdAt: e.created_at })),
      lines,
      figures,
      paid,
      balance: paid === null ? null : balanceOf(row.total, credited, paid),
    };
  }

  /** Raises the tax invoice of an order that has none, for the whole order. The invoice rules hold: not before approval, a gap-free number, signing that never holds it up. */
  async raise(orderId: string): Promise<RaiseOutcome> {
    const [order] = await this.db.execute<{ order_number: string; has_invoice: boolean }>(sql`
      SELECT o.order_number, EXISTS (SELECT 1 FROM invoice_documents d WHERE d.order_id = o.id AND d.document_type = 'tax_invoice') AS has_invoice FROM orders o WHERE o.id = ${orderId}`);
    if (order === undefined) return { ok: false, error: 'That order could not be found.' };
    if (order.has_invoice) return { ok: false, error: `Order ${order.order_number} already has a tax invoice.` };
    try {
      const made = await this.invoices.generatePdf(orderId, 'tax_invoice');
      return { ok: true, invoiceNumber: made.invoiceNumber, orderNumber: order.order_number };
    } catch (error) {
      // The invoice rules refuse in words (waiting for approval, cancelled); anything else is not shown.
      const text = error instanceof Error ? error.message : '';
      if (/approval|cancel|failed|not found|paid|payment/i.test(text) && text.length < 200) return { ok: false, error: text };
      console.error('[sales invoices] raise', orderId, error);
      return { ok: false, error: 'The invoice could not be made just now. Please try again.' };
    }
  }

  /** Sends an invoice again by email (the same number: it is numbered once). */
  async send(orderId: string, kind: InvoiceDocumentType): Promise<GeneratedInvoice> {
    return await this.invoices.generateAndEmail(orderId, kind);
  }

  /** The invoice's PDF to print or download (the same number: it is numbered once). */
  async pdf(orderId: string, kind: InvoiceDocumentType): Promise<GeneratedInvoice> {
    return await this.invoices.generatePdf(orderId, kind);
  }
}
