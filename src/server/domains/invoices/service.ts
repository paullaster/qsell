import { and, desc, eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  communicationOutbox,
  customers,
  invoiceDocuments,
  orders,
} from '@/server/db/drizzle/schema';
import type { CompanySettingsRepository } from '@/server/domains/company/repository';
import type { EmailPort, InvoicePayload, InvoicePdfPort } from '@/server/ports/communications';
import type { Order } from '@/types/index';
import { shownPaymentReference } from '@/lib/paymentReference';
import { getContainer } from '@/server/di/container';
import { businessDate } from '@/server/kernel/numbering/business-date';

export type InvoiceDocumentType = 'tax_invoice' | 'proforma';

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
  if (cause instanceof Error && cause.message) {
    return `${error.message}: ${cause.message}`;
  }
  return error.message;
}

function documentLabels(documentType: InvoiceDocumentType) {
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

function buildInvoiceEmailHtml(args: {
  documentType: InvoiceDocumentType;
  labels: ReturnType<typeof documentLabels>;
  company: InvoicePayload['company'];
  order: Order;
  invoiceNumber: string;
  buyerTaxPin?: string | null;
}): string {
  const { documentType, labels, company, order, invoiceNumber, buyerTaxPin } = args;
  const ship = order.shippingAddress;
  const itemRows = order.items
    .map(
      (item) => `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #E5E7EB;">
          <div style="font-weight:600;">${escapeHtml(item.productName)}</div>
        </td>
        <td style="padding:8px;border-bottom:1px solid #E5E7EB;text-align:center;">${item.quantity}</td>
        <td style="padding:8px;border-bottom:1px solid #E5E7EB;text-align:right;">${formatMoney(item.unitPrice, order.currency)}</td>
        <td style="padding:8px;border-bottom:1px solid #E5E7EB;text-align:right;">${formatMoney(item.totalPrice, order.currency)}</td>
      </tr>`,
    )
    .join('');

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
          ${paymentReference ? `<li>Reference: ${escapeHtml(paymentReference)}</li>` : ''}
          ${company.bankName ? `<li>Bank: ${escapeHtml(company.bankName)}</li>` : ''}
          ${company.bankAccountName ? `<li>Account name: ${escapeHtml(company.bankAccountName)}</li>` : ''}
          ${company.bankAccountNumber ? `<li>Account number: ${escapeHtml(company.bankAccountNumber)}</li>` : ''}
          ${company.bankBranch ? `<li>Branch: ${escapeHtml(company.bankBranch)}</li>` : ''}
        </ul>`
      : `<p style="margin:16px 0 0;color:#374151;">Payment status: <strong>${escapeHtml(order.paymentStatus.replace(/_/g, ' '))}</strong>${
          paymentReference ? ` · Ref: ${escapeHtml(paymentReference)}` : ''
        }</p>`;

  return `
    <div style="font-family: Arial, Helvetica, sans-serif; color: #111827; line-height: 1.5; max-width: 640px;">
      ${
        company.logoUrl
          ? `<img src="${escapeHtml(company.logoUrl)}" alt="${escapeHtml(company.tradingName)} logo" width="64" height="64" style="display:block;margin:0 0 12px;object-fit:contain;" />`
          : ''
      }
      <h2 style="margin: 0 0 4px; color: ${escapeHtml(company.accentColor)};">${escapeHtml(company.tradingName)}</h2>
      ${
        company.tagline
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
        <strong>${formatMoney(order.totalAmount, order.currency)}</strong>.
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
        <tr><td style="padding:4px 0;color:#6B7280;">Subtotal</td><td style="padding:4px 0;text-align:right;">${formatMoney(order.subtotal, order.currency)}</td></tr>
        <tr><td style="padding:4px 0;color:#6B7280;">VAT</td><td style="padding:4px 0;text-align:right;">${formatMoney(order.tax, order.currency)}</td></tr>
        <tr><td style="padding:4px 0;color:#6B7280;">Shipping</td><td style="padding:4px 0;text-align:right;">${formatMoney(order.shippingFee, order.currency)}</td></tr>
        <tr><td style="padding:8px 0;font-weight:700;">Total</td><td style="padding:8px 0;text-align:right;font-weight:700;">${formatMoney(order.totalAmount, order.currency)}</td></tr>
      </table>

      <p style="margin:16px 0 4px;color:#6B7280;font-size:12px;text-transform:uppercase;letter-spacing:0.04em;">Ship to</p>
      <p style="margin:0;color:#374151;font-size:13px;">
        ${escapeHtml(order.customerName)}<br/>
        ${buyerTaxPin ? `Tax PIN: ${escapeHtml(buyerTaxPin)}<br/>` : ''}
        ${escapeHtml(ship.street)}<br/>
        ${escapeHtml([ship.city, ship.countyOrState, ship.postalCode].filter(Boolean).join(', '))}<br/>
        ${escapeHtml(ship.country)}<br/>
        ${escapeHtml(order.customerPhone)} · ${escapeHtml(order.customerEmail)}
      </p>

      ${paymentBlock}

      <p style="color: #6B7280; font-size: 12px; margin-top: 20px;">
        ${escapeHtml(company.invoiceFooterNote || '')}
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
  private async numberDocument(order: Order, documentType: InvoiceDocumentType): Promise<string> {
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
            document: { kind, id: order.id },
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
            subtotal: String(order.subtotal),
            tax: String(order.tax),
            shippingFee: String(order.shippingFee),
            totalAmount: String(order.totalAmount),
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
            },
          })
          // Two requests for the same new document: both get the same number, one record.
          .onConflictDoNothing({ target: invoiceDocuments.invoiceNumber });
        return number;
      });
    } catch (error: unknown) {
      throw new Error(`Failed to save invoice record: ${dbErrorMessage(error)}`);
    }
  }

  private buildPayload(
    order: Order,
    invoiceNumber: string,
    company: InvoicePayload['company'],
    documentType: InvoiceDocumentType,
    buyerTaxPin: string | null,
  ): InvoicePayload {
    return {
      documentType,
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
      items: order.items.map((item) => ({
        sku: item.sku,
        name: item.productName,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        totalPrice: item.totalPrice,
      })),
      subtotal: order.subtotal,
      tax: order.tax,
      shippingFee: order.shippingFee,
      totalAmount: order.totalAmount,
      paymentMethod: order.paymentMethod,
      paymentReference: shownPaymentReference(order),
      paymentStatus: order.paymentStatus,
      notes: order.internalNotes || null,
    };
  }

  private async buyerTaxPin(order: Order): Promise<string | null> {
    if (!order.tradeCustomerId) return null;
    const [row] = await this.deps.db
      .select({ pin: customers.buyerKraPin })
      .from(customers)
      .where(eq(customers.id, order.tradeCustomerId))
      .limit(1);
    return row?.pin?.trim() || null;
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
      documentType === 'tax_invoice' &&
      ['pending', 'rejected', 'draft'].includes(order.approvalStatus ?? 'none')
    ) {
      throw new Error('A tax invoice cannot be issued while this order is waiting for approval.');
    }
    const company = await this.deps.companySettings.getProfile();
    const buyerTaxPin = await this.buyerTaxPin(order);
    const invoiceNumber = await this.numberDocument(order, documentType);
    const payload = this.buildPayload(order, invoiceNumber, company, documentType, buyerTaxPin);
    const pdf = await this.deps.invoicePdf.generate(payload);
    const filename = `${invoiceNumber}.pdf`;

    // Whether this document is signed with KRA is the signing policy's call, and signing must
    // never hold up the invoice (or the sale) it belongs to, so this is not awaited. The
    // service records every decision and failure itself and does not throw.
    void getContainer()
      .kraSigning.processOrderDocument({ orderId: order.id, documentType, invoiceNumber })
      .catch((error: unknown) => console.error('[kra-signing] hook failed', error));

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
    const company = await this.deps.companySettings.getProfile();
    const labels = documentLabels(documentType);
    const pdfBuffer = Buffer.from(generated.pdfBase64, 'base64');

    const buyerTaxPin = await this.buyerTaxPin(order);
    const subject = `${company.tradingName} ${labels.emailSubjectKind} ${generated.invoiceNumber}`;
    const html = buildInvoiceEmailHtml({
      documentType,
      labels,
      company,
      order,
      invoiceNumber: generated.invoiceNumber,
      buyerTaxPin,
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
          totalAmount: order.totalAmount,
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
        text: `Your ${company.tradingName} ${labels.title} ${generated.invoiceNumber} for ${order.currency} ${order.totalAmount} is attached.`,
        replyTo: company.email,
        fromOverride: `${company.tradingName} Billing <${company.email}>`,
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
    return this.deps.db
      .select()
      .from(invoiceDocuments)
      .where(eq(invoiceDocuments.orderId, orderId))
      .orderBy(desc(invoiceDocuments.createdAt));
  }
}
