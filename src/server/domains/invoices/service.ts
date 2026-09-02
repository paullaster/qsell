import { desc, eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { communicationOutbox, invoiceDocuments } from '@/server/db/drizzle/schema';
import type { CompanySettingsRepository } from '@/server/domains/company/repository';
import type { EmailPort, InvoicePayload, InvoicePdfPort } from '@/server/ports/communications';
import type { Order } from '@/types/index';
import { AdminService } from '@/server/domains/gateways/service';

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
}): string {
  const { documentType, labels, company, order, invoiceNumber } = args;
  const ship = order.shippingAddress;
  const itemRows = order.items
    .map(
      (item) => `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #E5E7EB;">
          <div style="font-weight:600;">${escapeHtml(item.productName)}</div>
          <div style="color:#6B7280;font-size:12px;font-family:monospace;">${escapeHtml(item.sku)}</div>
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

  const paymentBlock =
    documentType === 'proforma'
      ? `
        <p style="margin:16px 0 8px;font-weight:700;color:${escapeHtml(company.accentColor)};">Payment details</p>
        <ul style="margin:0;padding-left:18px;color:#374151;">
          <li>Preferred method: ${escapeHtml(order.paymentMethod.replace(/_/g, ' '))}</li>
          ${
            order.transactionReference || order.mpesaReceiptNumber
              ? `<li>Reference: ${escapeHtml(order.transactionReference || order.mpesaReceiptNumber || '')}</li>`
              : ''
          }
          ${company.bankName ? `<li>Bank: ${escapeHtml(company.bankName)}</li>` : ''}
          ${company.bankAccountName ? `<li>Account name: ${escapeHtml(company.bankAccountName)}</li>` : ''}
          ${company.bankAccountNumber ? `<li>Account number: ${escapeHtml(company.bankAccountNumber)}</li>` : ''}
          ${company.bankBranch ? `<li>Branch: ${escapeHtml(company.bankBranch)}</li>` : ''}
        </ul>`
      : `<p style="margin:16px 0 0;color:#374151;">Payment status: <strong>${escapeHtml(order.paymentStatus.replace(/_/g, ' '))}</strong>${
          order.transactionReference || order.mpesaReceiptNumber
            ? ` · Ref: ${escapeHtml(order.transactionReference || order.mpesaReceiptNumber || '')}`
            : ''
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

  private nextInvoiceNumber(prefix: string): string {
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const unique = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
    return `${prefix}-${stamp}-${unique}`;
  }

  private buildPayload(
    order: Order,
    invoiceNumber: string,
    company: InvoicePayload['company'],
    documentType: InvoiceDocumentType,
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
      paymentReference: order.transactionReference || order.mpesaReceiptNumber || null,
      paymentStatus: order.paymentStatus,
      notes: order.internalNotes || null,
    };
  }

  private resolveOrder(orderId: string): Order {
    const order = AdminService.getAllOrders().find((o) => o.id === orderId);
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
    const order = this.resolveOrder(orderId);
    this.assertProformaAllowed(order, documentType);
    const company = await this.deps.companySettings.getProfile();
    const prefix = documentType === 'proforma' ? 'PRO' : company.invoicePrefix;
    const invoiceNumber = this.nextInvoiceNumber(prefix);
    const payload = this.buildPayload(order, invoiceNumber, company, documentType);
    const pdf = await this.deps.invoicePdf.generate(payload);
    const filename = `${invoiceNumber}.pdf`;

    try {
      await this.deps.db.insert(invoiceDocuments).values({
        orderId: order.id,
        orderNumber: order.orderNumber,
        invoiceNumber,
        documentType,
        customerEmail: order.customerEmail,
        customerName: order.customerName,
        currency: order.currency,
        subtotal: String(order.subtotal),
        tax: String(order.tax),
        shippingFee: String(order.shippingFee),
        totalAmount: String(order.totalAmount),
        pdfStorageKey: filename,
        emailStatus: 'not_sent',
        meta: {
          pdfAdapter: this.deps.invoicePdf.name,
          documentType,
          paymentMethod: order.paymentMethod,
          paymentReference: payload.paymentReference,
        },
      });
    } catch (error: unknown) {
      throw new Error(`Failed to save invoice record: ${dbErrorMessage(error)}`);
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
    const order = this.resolveOrder(orderId);
    const company = await this.deps.companySettings.getProfile();
    const labels = documentLabels(documentType);
    const pdfBuffer = Buffer.from(generated.pdfBase64, 'base64');

    const subject = `${company.tradingName} ${labels.emailSubjectKind} ${generated.invoiceNumber}`;
    const html = buildInvoiceEmailHtml({
      documentType,
      labels,
      company,
      order,
      invoiceNumber: generated.invoiceNumber,
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
