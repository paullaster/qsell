import { lineDisplay } from '@/lib/unit-rules';
import { and, desc, eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  communicationOutbox,
  customers,
  invoiceDocuments,
  orders,
  type OrderDeliveryRow,
} from '@/server/db/drizzle/schema';
import type { CompanySettingsRepository } from '@/server/domains/company/repository';
import type { EmailPort, InvoicePayload, InvoicePdfPort } from '@/server/ports/communications';
import type { Order } from '@/types/index';
import type { InvoiceFigures, InvoicePlan } from '@/lib/delivery-invoicing';
import { invoicePlanFor } from '@/server/domains/delivery/invoice-plan';
import { shownPaymentReference } from '@/lib/paymentReference';
import { getContainer } from '@/server/di/container';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { resolveDocumentLayouts } from '@/lib/document-layouts';
import { has, trimToNull } from '@/lib/values';

/** `delivery_invoice` is the delivery service's own tax invoice, for a company that bills delivery apart from the goods. */
export type InvoiceDocumentType = 'tax_invoice' | 'proforma' | 'delivery_invoice';

export interface InvoiceServiceDeps {
  db: DrizzleDb;
  companySettings: CompanySettingsRepository;
  invoicePdf: InvoicePdfPort;
  email: EmailPort;
}

export interface GeneratedInvoice {
  invoiceNumber: string;
  documentType: InvoiceDocumentType;
  orderId: string;
  orderNumber: string;
  pdfBase64: string;
  filename: string;
  mimeType: 'application/pdf';
  emailed?: boolean;
  emailMessageId?: string;
}

function dbErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'Database operation failed';
  }
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message !== '') {
    return `${error.message}: ${cause.message}`;
  }
  return error.message;
}

function documentLabels(documentType: InvoiceDocumentType) {
  if (documentType === 'delivery_invoice') {
    return {
      title: 'Tax Invoice: Delivery Service',
      emailSubjectKind: 'Tax Invoice (Delivery Service)',
      emailIntro: 'tax invoice for the delivery service',
      templateKey: 'tax_invoice_delivery',
    };
  }
  if (documentType === 'proforma') {
    return {
      title: 'Proforma Invoice',
      emailSubjectKind: 'Proforma Invoice',
      emailIntro: 'proforma invoice (payment request)',
      templateKey: 'proforma_invoice',
    };
  }
  return {
    title: 'Tax Invoice',
    emailSubjectKind: 'Tax Invoice',
    emailIntro: 'tax invoice',
    templateKey: 'tax_invoice',
  };
}

function formatMoney(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString('en-KE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const orderLine = (item: Order['items'][number]) => ({
  quantity: item.quantity,
  unitPrice: item.unitPrice,
  total: item.totalPrice,
  unitCode: item.unitCode,
  enteredQuantity: item.enteredQuantity,
  enteredUnitPrice: item.enteredUnitPrice,
});

/** "3 crate" or "12" as the line was typed. */
function shownQuantity(item: Order['items'][number]): string {
  const shown = lineDisplay(orderLine(item));
  return shown.unit === null
    ? String(shown.quantity)
    : `${String(shown.quantity)} ${escapeHtml(shown.unit)}`;
}

function buildInvoiceEmailHtml(args: {
  documentType: InvoiceDocumentType;
  labels: ReturnType<typeof documentLabels>;
  company: InvoicePayload['company'];
  order: Order;
  invoiceNumber: string;
  buyerTaxPin?: string | null;
  /** The money of this document: the products' invoice (with delivery on it, or not) or the delivery service's own. */
  figures: InvoiceFigures;
  /** True for the delivery service's own invoice: no product lines. */
  deliveryOnly?: boolean;
}): string {
  const { documentType, labels, company, order, invoiceNumber, buyerTaxPin, figures } = args;
  const ship = order.shippingAddress;
  const deliveryRow =
    figures.deliveryLine === null
      ? ''
      : `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #E5E7EB;">
          <div style="font-weight:600;">${escapeHtml(figures.deliveryLine.name)}</div>
        </td>
        <td style="padding:8px;border-bottom:1px solid #E5E7EB;text-align:center;">1</td>
        <td style="padding:8px;border-bottom:1px solid #E5E7EB;text-align:right;">${formatMoney(figures.deliveryLine.net, order.currency)}</td>
        <td style="padding:8px;border-bottom:1px solid #E5E7EB;text-align:right;">${formatMoney(figures.deliveryLine.net, order.currency)}</td>
      </tr>`;
  const itemRows = (args.deliveryOnly === true ? [] : order.items)
    .map(
      (item) => `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #E5E7EB;">
          <div style="font-weight:600;">${escapeHtml(item.productName)}</div>
        </td>
        <td style="padding:8px;border-bottom:1px solid #E5E7EB;text-align:center;">${shownQuantity(item)}</td>
        <td style="padding:8px;border-bottom:1px solid #E5E7EB;text-align:right;">${formatMoney(lineDisplay(orderLine(item)).unitPrice, order.currency)}</td>
        <td style="padding:8px;border-bottom:1px solid #E5E7EB;text-align:right;">${formatMoney(item.totalPrice, order.currency)}</td>
      </tr>`,
    )
    .join('') + deliveryRow;

  const companyAddress = [
    company.streetAddress,
    [company.city, company.countyOrState, company.postalCode].filter(Boolean).join(', '),
    company.country,
    company.locationLabel,
  ]
    .filter((line): line is string => typeof line === 'string' && line.trim().length > 0)
    .map(escapeHtml)
    .join('<br/>');

  const paymentReference = shownPaymentReference(order);
  const paymentBlock =
    documentType === 'proforma'
      ? `
        <p style="margin:16px 0 8px;font-weight:700;color:${escapeHtml(company.accentColor)};">Payment details</p>
        <ul style="margin:0;padding-left:18px;color:#374151;">
          <li>Preferred method: ${escapeHtml(order.paymentMethod.replace(/_/g, ' '))}</li>
          ${has(paymentReference) ? `<li>Reference: ${escapeHtml(paymentReference)}</li>` : ''}
          ${has(company.bankName) ? `<li>Bank: ${escapeHtml(company.bankName)}</li>` : ''}
          ${has(company.bankAccountName) ? `<li>Account name: ${escapeHtml(company.bankAccountName)}</li>` : ''}
          ${has(company.bankAccountNumber) ? `<li>Account number: ${escapeHtml(company.bankAccountNumber)}</li>` : ''}
          ${has(company.bankBranch) ? `<li>Branch: ${escapeHtml(company.bankBranch)}</li>` : ''}
        </ul>`
      : `<p style="margin:16px 0 0;color:#374151;">Payment status: <strong>${escapeHtml(order.paymentStatus.replace(/_/g, ' '))}</strong>${
          has(paymentReference) ? ` · Ref: ${escapeHtml(paymentReference)}` : ''
        }</p>`;

  return `
    <div style="font-family: Arial, Helvetica, sans-serif; color: #111827; line-height: 1.5; max-width: 640px;">
      ${
        has(company.logoUrl)
          ? `<img src="${escapeHtml(company.logoUrl)}" alt="${escapeHtml(company.tradingName)} logo" width="64" height="64" style="display:block;margin:0 0 12px;object-fit:contain;" />`
          : ''
      }
      <h2 style="margin: 0 0 4px; color: ${escapeHtml(company.accentColor)};">${escapeHtml(company.tradingName)}</h2>
      ${
        has(company.tagline)
          ? `<p style="margin:0 0 8px;color:#6B7280;font-size:12px;text-transform:uppercase;letter-spacing:0.04em;">${escapeHtml(company.tagline)}</p>`
          : ''
      }
      <p style="margin: 0 0 4px; color: #4B5563; font-size: 13px;">${escapeHtml(company.legalName)}</p>
      <p style="margin: 0 0 16px; color: #6B7280; font-size: 12px;">
        ${companyAddress}<br/>
        Email: ${escapeHtml(company.email)} · Phone: ${escapeHtml(company.phone)}<br/>
        KRA PIN: ${escapeHtml(company.kraPin)}
      </p>
      <p style="margin: 0 0 16px; color: #4B5563;">
        Your ${escapeHtml(labels.emailIntro)} for order <strong>${escapeHtml(order.orderNumber)}</strong>.
      </p>
      <p>Dear ${escapeHtml(order.customerName)},</p>
      <p>
        Please find attached your <strong>${escapeHtml(labels.title)}</strong>
        <strong>${escapeHtml(invoiceNumber)}</strong> totaling
        <strong>${formatMoney(figures.totalAmount, order.currency)}</strong>.
      </p>

      <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;">
        <thead>
          <tr style="background:${escapeHtml(company.primaryColor)};color:#fff;">
            <th style="padding:8px;text-align:left;">Item</th>
            <th style="padding:8px;text-align:center;">Qty</th>
            <th style="padding:8px;text-align:right;">Unit</th>
            <th style="padding:8px;text-align:right;">Amount</th>
          </tr>
        </thead>
        <tbody>${itemRows}</tbody>
      </table>

      <table style="width:100%;max-width:280px;margin-left:auto;font-size:13px;border-collapse:collapse;">
        <tr><td style="padding:4px 0;color:#6B7280;">Subtotal</td><td style="padding:4px 0;text-align:right;">${formatMoney(figures.subtotal, order.currency)}</td></tr>
        ${figures.taxRows.map((r) => `<tr><td style="padding:4px 0;color:#6B7280;">${escapeHtml(r.label)}</td><td style="padding:4px 0;text-align:right;">${formatMoney(r.amount, order.currency)}</td></tr>`).join('')}
        ${figures.shippingFee > 0 ? `<tr><td style="padding:4px 0;color:#6B7280;">Shipping</td><td style="padding:4px 0;text-align:right;">${formatMoney(figures.shippingFee, order.currency)}</td></tr>` : ''}
        <tr><td style="padding:8px 0;font-weight:700;">Total</td><td style="padding:8px 0;text-align:right;font-weight:700;">${formatMoney(figures.totalAmount, order.currency)}</td></tr>
      </table>

      <p style="margin:16px 0 4px;color:#6B7280;font-size:12px;text-transform:uppercase;letter-spacing:0.04em;">Ship to</p>
      <p style="margin:0;color:#374151;font-size:13px;">
        ${escapeHtml(order.customerName)}<br/>
        ${has(buyerTaxPin) ? `Tax PIN: ${escapeHtml(buyerTaxPin)}<br/>` : ''}
        ${escapeHtml(ship.street)}<br/>
        ${escapeHtml([ship.city, ship.countyOrState, ship.postalCode].filter(Boolean).join(', '))}<br/>
        ${escapeHtml(ship.country)}<br/>
        ${escapeHtml([order.customerPhone, order.customerEmail].filter((v) => v.trim() !== '').join(' · '))}
      </p>

      ${paymentBlock}

      <p style="color: #6B7280; font-size: 12px; margin-top: 20px;">
        ${escapeHtml(resolveDocumentLayouts(company.documentLayouts, company.invoiceFooterNote ?? '').invoice.footerText)}
      </p>
    </div>
  `;
}

export class InvoiceService {
  constructor(private readonly deps: InvoiceServiceDeps) {}

  /**
   * The document's number, from the number series, once per order and document type: asking
   * again (re-download, re-email) returns the same number and does not create another record.
   * The number and the record are saved in one short transaction, so a gap-free series gives its
   * number back if the save fails; the PDF is rendered afterwards, never while the lock is held.
   */
  private async numberDocument(order: Order, documentType: InvoiceDocumentType, figures: InvoiceFigures, billingMode: string, serviceProductId: string | null): Promise<string> {
    const [existing] = await this.deps.db
      .select({ invoiceNumber: invoiceDocuments.invoiceNumber })
      .from(invoiceDocuments)
      .where(
        and(
          eq(invoiceDocuments.orderId, order.id),
          eq(invoiceDocuments.documentType, documentType),
        ),
      )
      .limit(1);
    if (existing) return existing.invoiceNumber;

    const kind = documentType === 'proforma' ? 'proforma_invoice' : 'tax_invoice';
    // The delivery service's own invoice comes from the same tax invoice series (one legal sequence), as its own document.
    const documentId = documentType === 'delivery_invoice' ? `${order.id}#delivery` : order.id;
    const company = await this.deps.companySettings.ensureSeeded();
    const [row] = await this.deps.db
      .select({ branchId: orders.branchId })
      .from(orders)
      .where(eq(orders.id, order.id))
      .limit(1);

    try {
      return await this.deps.db.transaction(async (tx) => {
        const { number } = await getContainer().numbering.assign(
          kind,
          {
            companyId: company.id,
            branchId: row?.branchId ?? null,
            date: businessDate(),
            document: { kind, id: documentId },
          },
          tx,
        );
        await tx
          .insert(invoiceDocuments)
          .values({
            orderId: order.id,
            orderNumber: order.orderNumber,
            invoiceNumber: number,
            documentType,
            customerEmail: order.customerEmail,
            customerName: order.customerName,
            currency: order.currency,
            subtotal: String(figures.subtotal),
            tax: String(figures.totalTax),
            shippingFee: String(figures.shippingFee),
            totalAmount: String(figures.totalAmount),
            pdfStorageKey: `${number}.pdf`,
            emailStatus: 'not_sent',
            meta: {
              pdfAdapter: this.deps.invoicePdf.name,
              documentType,
              paymentMethod: order.paymentMethod,
              paymentReference: shownPaymentReference(order),
              transmitInvoicesToKra: order.transmitInvoicesToKra === true,
              customerAccountType: order.customerAccountType ?? null,
              tradeCustomerId: order.tradeCustomerId ?? null,
              deliveryBilling: billingMode,
              deliveryServiceProductId: serviceProductId,
            },
          })
          // Two requests for the same new document: both get the same number, one record.
          .onConflictDoNothing({ target: invoiceDocuments.invoiceNumber });
        return number;
      });
    } catch (error: unknown) {
      throw new Error(`Failed to save invoice record: ${dbErrorMessage(error)}`, { cause: error });
    }
  }

  private buildPayload(
    order: Order,
    invoiceNumber: string,
    company: InvoicePayload['company'],
    documentType: InvoiceDocumentType,
    buyerTaxPin: string | null,
    figures: InvoiceFigures,
  ): InvoicePayload {
    const deliveryOnly = documentType === 'delivery_invoice';
    const goods = deliveryOnly
      ? []
      : order.items.map((item) => {
          const shown = lineDisplay(orderLine(item));
          return {
            sku: item.sku,
            name: item.productName,
            quantity: shown.quantity,
            unit: shown.unit,
            unitPrice: shown.unitPrice,
            totalPrice: item.totalPrice,
          };
        });
    // Delivery is a line beside the products (or the only line of its own invoice), before tax, like the products' tax row.
    const delivery = figures.deliveryLine === null ? [] : [{ sku: 'DELIVERY', name: figures.deliveryLine.name, quantity: 1, unit: null, unitPrice: figures.deliveryLine.net, totalPrice: figures.deliveryLine.net }];
    return {
      documentType: deliveryOnly ? 'tax_invoice' : documentType,
      ...(deliveryOnly ? { documentTitle: 'Tax Invoice: Delivery Service' } : {}),
      invoiceNumber,
      issuedAt: new Date().toISOString(),
      orderId: order.id,
      orderNumber: order.orderNumber,
      currency: order.currency,
      company,
      customer: {
        name: order.customerName,
        email: order.customerEmail,
        phone: order.customerPhone,
        kraPin: buyerTaxPin,
        shippingAddress: order.shippingAddress,
      },
      items: [...goods, ...delivery],
      subtotal: figures.subtotal,
      tax: figures.totalTax,
      taxRows: figures.taxRows,
      shippingFee: figures.shippingFee,
      totalAmount: figures.totalAmount,
      paymentMethod: order.paymentMethod,
      paymentReference: shownPaymentReference(order),
      paymentStatus: order.paymentStatus,
      notes: trimToNull(order.internalNotes),
    };
  }

  /**
   * How this order's money is laid out on its invoices: the company's choice (delivery on the goods invoice, or on its own) applied
   * to the delivery the order was given. A layout that does not add up to the order is refused, never issued. A proforma is one
   * request for payment, so it always shows delivery with the goods.
   */
  async planFor(order: Order, documentType: InvoiceDocumentType = 'tax_invoice'): Promise<{ plan: InvoicePlan; delivery: OrderDeliveryRow | null; figures: InvoiceFigures; serviceProductId: string | null }> {
    const company = await this.deps.companySettings.ensureSeeded();
    const { plan, delivery, figures, serviceProductId } = await invoicePlanFor(this.deps.db, company.id, order.id, documentType);
    return { plan, delivery, figures, serviceProductId };
  }

  /** True when the order has a delivery invoice of its own: delivery is billed apart and has been charged. */
  async hasDeliveryInvoice(orderId: string): Promise<boolean> {
    const order = await this.resolveOrder(orderId);
    const { plan } = await this.planFor(order, 'tax_invoice');
    return plan.deliveryInvoice !== null;
  }

  private async buyerTaxPin(order: Order): Promise<string | null> {
    if (!has(order.tradeCustomerId)) return null;
    const [row] = await this.deps.db
      .select({ pin: customers.buyerKraPin })
      .from(customers)
      .where(eq(customers.id, order.tradeCustomerId))
      .limit(1);
    return trimToNull(row?.pin);
  }

  private async resolveOrder(orderId: string): Promise<Order> {
    const order = await getContainer().orders.getById(orderId);
    if (!order) {
      throw new Error(`Order ${orderId} not found`);
    }
    return order;
  }

  private assertProformaAllowed(order: Order, documentType: InvoiceDocumentType): void {
    if (documentType !== 'proforma') return;
    if (order.paymentStatus === 'paid' || order.paymentStatus === 'reconciled') {
      throw new Error(
        'Proforma invoice is not available for paid orders. Use the posted tax invoice instead.',
      );
    }
  }

  async generatePdf(
    orderId: string,
    documentType: InvoiceDocumentType = 'tax_invoice',
  ): Promise<GeneratedInvoice> {
    const order = await this.resolveOrder(orderId);
    this.assertProformaAllowed(order, documentType);
    // A tax invoice is a fiscal document: not before the sale has been approved.
    if (
      documentType !== 'proforma' &&
      ['pending', 'rejected', 'draft'].includes(order.approvalStatus ?? 'none')
    ) {
      throw new Error('A tax invoice cannot be issued while this order is waiting for approval.');
    }
    const company = await this.deps.companySettings.getProfile();
    const buyerTaxPin = await this.buyerTaxPin(order);
    const { plan, figures, serviceProductId } = await this.planFor(order, documentType);
    const invoiceNumber = await this.numberDocument(order, documentType, figures, plan.mode, serviceProductId);
    const payload = this.buildPayload(order, invoiceNumber, company, documentType, buyerTaxPin, figures);
    const pdf = await this.deps.invoicePdf.generate(payload);
    const filename = `${invoiceNumber}.pdf`;

    // Whether this document is signed with KRA is the signing policy's call, and signing must
    // never hold up the invoice (or the sale) it belongs to, so this is not awaited. The
    // service records every decision and failure itself and does not throw.
    const signing = getContainer().kraSigning;
    void (documentType === 'delivery_invoice'
      ? signing.processOrderDeliveryDocument({ orderId: order.id, invoiceNumber })
      : signing.processOrderDocument({ orderId: order.id, documentType, invoiceNumber })
    ).catch((error: unknown) => console.error('[kra-signing] hook failed', error));
    // A company that bills delivery on its own invoice gets that invoice with the goods invoice, numbered and signed on its own.
    if (documentType === 'tax_invoice' && plan.deliveryInvoice !== null) {
      void this.generatePdf(order.id, 'delivery_invoice').catch((error: unknown) => console.error('[invoices] delivery invoice failed', error));
    }

    return {
      invoiceNumber,
      documentType,
      orderId: order.id,
      orderNumber: order.orderNumber,
      pdfBase64: pdf.toString('base64'),
      filename,
      mimeType: 'application/pdf',
    };
  }

  async generateAndEmail(
    orderId: string,
    documentType: InvoiceDocumentType = 'tax_invoice',
  ): Promise<GeneratedInvoice> {
    const generated = await this.generatePdf(orderId, documentType);
    const order = await this.resolveOrder(orderId);
    if (order.customerEmail.trim() === '')
      throw new Error(
        'This order has no email address to send the invoice to. Download it instead.',
      );
    const company = await this.deps.companySettings.getProfile();
    const labels = documentLabels(documentType);
    const pdfBuffer = Buffer.from(generated.pdfBase64, 'base64');

    const buyerTaxPin = await this.buyerTaxPin(order);
    const { figures } = await this.planFor(order, documentType);
    const subject = `${company.tradingName} ${labels.emailSubjectKind} ${generated.invoiceNumber}`;
    const html = buildInvoiceEmailHtml({
      documentType,
      labels,
      company,
      order,
      invoiceNumber: generated.invoiceNumber,
      buyerTaxPin,
      figures,
      deliveryOnly: documentType === 'delivery_invoice',
    });

    const [outbox] = await this.deps.db
      .insert(communicationOutbox)
      .values({
        channel: 'email',
        templateKey: labels.templateKey,
        recipient: order.customerEmail,
        subject,
        payload: {
          orderId: order.id,
          orderNumber: order.orderNumber,
          invoiceNumber: generated.invoiceNumber,
          documentType,
          customerEmail: order.customerEmail,
          totalAmount: figures.totalAmount,
          currency: order.currency,
          companyTradingName: company.tradingName,
          adapter: this.deps.email.name,
        },
        status: 'processing',
        attempts: 1,
      })
      .returning();

    if (!outbox) {
      throw new Error('Failed to create communication outbox entry');
    }

    try {
      const result = await this.deps.email.send({
        to: order.customerEmail,
        subject,
        html,
        text: `Your ${company.tradingName} ${labels.title} ${generated.invoiceNumber} for ${order.currency} ${figures.totalAmount} is attached.`,
        sender: { name: company.tradingName, address: company.email },
        attachments: [
          {
            filename: generated.filename,
            content: pdfBuffer,
            contentType: 'application/pdf',
          },
        ],
      });

      await this.deps.db
        .update(communicationOutbox)
        .set({
          status: 'sent',
          sentAt: new Date(),
          updatedAt: new Date(),
          payload: {
            orderId: order.id,
            invoiceNumber: generated.invoiceNumber,
            documentType,
            adapter: this.deps.email.name,
            messageId: result.messageId,
          },
        })
        .where(eq(communicationOutbox.id, outbox.id));

      await this.deps.db
        .update(invoiceDocuments)
        .set({
          emailStatus: 'sent',
          emailedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(invoiceDocuments.invoiceNumber, generated.invoiceNumber));

      return {
        ...generated,
        emailed: true,
        emailMessageId: result.messageId,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Email send failed';
      await this.deps.db
        .update(communicationOutbox)
        .set({
          status: 'failed',
          lastError: message,
          updatedAt: new Date(),
        })
        .where(eq(communicationOutbox.id, outbox.id));

      await this.deps.db
        .update(invoiceDocuments)
        .set({
          emailStatus: 'failed',
          emailError: message,
          updatedAt: new Date(),
        })
        .where(eq(invoiceDocuments.invoiceNumber, generated.invoiceNumber));

      throw error;
    }
  }

  async listForOrder(orderId: string) {
    return await this.deps.db
      .select()
      .from(invoiceDocuments)
      .where(eq(invoiceDocuments.orderId, orderId))
      .orderBy(desc(invoiceDocuments.createdAt));
  }
}
