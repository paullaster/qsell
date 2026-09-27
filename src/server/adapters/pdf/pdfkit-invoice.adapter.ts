import PDFDocument from 'pdfkit';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { InvoicePdfPort, InvoicePayload } from '@/server/ports/communications';

function money(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString('en-KE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function nonEmpty(parts: Array<string | null | undefined>): string[] {
  return parts.filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
}

function resolveLocalLogoPath(logoUrl?: string | null): string | null {
  if (!logoUrl || !logoUrl.startsWith('/')) return null;
  const apiRoute = logoUrl.match(/^\/api\/company\/logo\/(logo-[a-z\d-]+\.(?:png|jpg|webp|svg))$/i);
  const legacyPath = logoUrl.match(/^\/uploads\/company\/(logo-[a-z\d-]+\.(?:png|jpg|webp|svg))$/i);
  const filename = apiRoute?.[1] ?? legacyPath?.[1];
  if (!filename) return null;
  const absolute = path.join(process.cwd(), 'public', 'uploads', 'company', filename);
  return existsSync(absolute) ? absolute : null;
}

/**
 * Clear A4 tax / proforma invoice.
 * Tax invoice = posted (no payment instructions).
 * Proforma = quote-style with bank/payment details.
 */
export class PdfKitInvoiceAdapter implements InvoicePdfPort {
  readonly name = 'pdfkit';

  generate(payload: InvoicePayload): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const isProforma = payload.documentType !== 'tax_invoice';
      const isQuote = payload.documentType === 'sales_quote';
      const title = isQuote ? 'SALES QUOTATION' : isProforma ? 'PROFORMA INVOICE' : 'TAX INVOICE';
      const docLabel = isQuote ? 'Quote No.' : isProforma ? 'Proforma No.' : 'Invoice No.';

      const doc = new PDFDocument({
        size: 'A4',
        margin: 0,
        bufferPages: true,
        info: {
          Title: `${title} ${payload.invoiceNumber}`,
          Author: payload.company.legalName,
          Subject: `${title} for order ${payload.orderNumber}`,
        },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      doc.on('end', () => {
        resolve(Buffer.concat(chunks));
      });
      doc.on('error', reject);

      const PAGE_W = doc.page.width;
      const PAGE_H = doc.page.height;
      const M = 42;
      const CONTENT_W = PAGE_W - M * 2;
      const primary = payload.company.primaryColor || '#111827';
      const accent = payload.company.accentColor || '#4F46E5';
      const muted = '#6B7280';
      const ink = '#111827';
      const line = '#E5E7EB';

      doc.rect(0, 0, PAGE_W, 6).fill(accent);

      const headerTop = 28;
      const leftW = CONTENT_W * 0.55;
      const rightW = CONTENT_W * 0.42;
      const rightX = M + CONTENT_W - rightW;

      let brandX = M;
      const logoPath = resolveLocalLogoPath(payload.company.logoUrl);
      if (logoPath) {
        try {
          doc.image(logoPath, M, headerTop, { fit: [48, 48] });
          brandX = M + 56;
        } catch {
          // Fall back to text-only header if image decode fails
        }
      }

      doc
        .fillColor(primary)
        .font('Helvetica-Bold')
        .fontSize(16)
        .text(payload.company.tradingName || payload.company.legalName, brandX, headerTop, {
          width: leftW - (brandX - M),
          lineGap: 2,
        });

      if (payload.company.tagline) {
        doc
          .fillColor(muted)
          .font('Helvetica')
          .fontSize(8)
          .text(payload.company.tagline, brandX, doc.y + 2, {
            width: leftW - (brandX - M),
            lineBreak: false,
          });
      }

      let leftY = Math.max(doc.y + 6, logoPath ? headerTop + 52 : doc.y + 4);
      doc.fillColor(muted).font('Helvetica').fontSize(8);
      const companyLines = nonEmpty([
        payload.company.legalName !== payload.company.tradingName
          ? payload.company.legalName
          : null,
        payload.company.streetAddress,
        [payload.company.city, payload.company.countyOrState, payload.company.postalCode]
          .filter(Boolean)
          .join(', '),
        payload.company.country,
        payload.company.locationLabel,
        payload.company.tel ? `Tel: ${payload.company.tel}` : null,
        `Email: ${payload.company.email}`,
        payload.company.website ? `Web: ${payload.company.website}` : null,
        `KRA PIN: ${payload.company.kraPin}`,
      ]);

      for (const row of companyLines) {
        doc.text(row, M, leftY, { width: leftW, lineBreak: false });
        leftY += 11;
      }

      let rightY = headerTop;
      doc
        .fillColor(accent)
        .font('Helvetica-Bold')
        .fontSize(16)
        .text(title, rightX, rightY, { width: rightW, align: 'right', lineBreak: false });
      rightY += 24;

      const metaRows: Array<[string, string]> = [
        [docLabel, payload.invoiceNumber],
        ['Order No.', payload.orderNumber],
        ['Issue Date', new Date(payload.issuedAt).toLocaleDateString('en-KE')],
        ['Order status', payload.paymentStatus.replace(/_/g, ' ').toUpperCase()],
        ['Currency', payload.currency],
      ];

      for (const [label, value] of metaRows) {
        doc
          .fillColor(muted)
          .font('Helvetica')
          .fontSize(8)
          .text(label, rightX, rightY, { width: rightW * 0.4, lineBreak: false });
        doc
          .fillColor(ink)
          .font('Helvetica-Bold')
          .fontSize(8)
          .text(value, rightX + rightW * 0.4, rightY, {
            width: rightW * 0.6,
            align: 'right',
            lineBreak: false,
          });
        rightY += 13;
      }

      let y = Math.max(leftY, rightY) + 14;
      doc
        .moveTo(M, y)
        .lineTo(M + CONTENT_W, y)
        .strokeColor(line)
        .lineWidth(1)
        .stroke();
      y += 16;

      const colGap = 18;
      const halfW = (CONTENT_W - colGap) / 2;
      const shipX = M + halfW + colGap;
      const blockTop = y;

      doc.fillColor(accent).font('Helvetica-Bold').fontSize(9).text('BILL TO', M, blockTop, {
        width: halfW,
        lineBreak: false,
      });
      doc
        .fillColor(accent)
        .font('Helvetica-Bold')
        .fontSize(9)
        .text('SHIP TO', shipX, blockTop, { width: halfW, lineBreak: false });

      let billY = blockTop + 14;
      let shipY = blockTop + 14;

      const billLines = nonEmpty([
        payload.customer.name,
        payload.customer.email,
        payload.customer.phone,
        payload.customer.kraPin ? `Tax PIN: ${payload.customer.kraPin}` : null,
      ]);
      doc.fillColor(ink).font('Helvetica-Bold').fontSize(10);
      doc.text(billLines[0] ?? '', M, billY, { width: halfW, lineBreak: false });
      billY += 13;
      doc.fillColor(muted).font('Helvetica').fontSize(8);
      for (const row of billLines.slice(1)) {
        doc.text(row, M, billY, { width: halfW, lineBreak: false });
        billY += 11;
      }

      const shipLines = nonEmpty([
        payload.customer.name,
        payload.customer.shippingAddress.street,
        [
          payload.customer.shippingAddress.city,
          payload.customer.shippingAddress.countyOrState,
          payload.customer.shippingAddress.postalCode,
        ]
          .filter(Boolean)
          .join(', '),
        payload.customer.shippingAddress.country,
        payload.customer.phone,
      ]);
      doc.fillColor(ink).font('Helvetica-Bold').fontSize(10);
      doc.text(shipLines[0] ?? '', shipX, shipY, { width: halfW, lineBreak: false });
      shipY += 13;
      doc.fillColor(muted).font('Helvetica').fontSize(8);
      for (const row of shipLines.slice(1)) {
        doc.text(row, shipX, shipY, { width: halfW, lineBreak: false });
        shipY += 11;
      }

      y = Math.max(billY, shipY) + 18;

      const cols = {
        desc: { x: M, w: 282 },
        qty: { x: M + 282, w: 36 },
        unit: { x: M + 318, w: 90 },
        amount: { x: M + 408, w: CONTENT_W - 408 },
      };

      const drawTableHeader = (atY: number) => {
        doc.rect(M, atY, CONTENT_W, 22).fill(primary);
        doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(8);
        doc.text('DESCRIPTION', cols.desc.x + 6, atY + 7, {
          width: cols.desc.w - 8,
          lineBreak: false,
        });
        doc.text('QTY', cols.qty.x, atY + 7, {
          width: cols.qty.w,
          align: 'right',
          lineBreak: false,
        });
        doc.text('UNIT PRICE', cols.unit.x, atY + 7, {
          width: cols.unit.w,
          align: 'right',
          lineBreak: false,
        });
        doc.text('AMOUNT', cols.amount.x, atY + 7, {
          width: cols.amount.w - 6,
          align: 'right',
          lineBreak: false,
        });
        return atY + 22;
      };

      y = drawTableHeader(y);
      const footerReserve = isProforma ? 240 : 180;

      for (const [index, item] of payload.items.entries()) {
        doc.font('Helvetica').fontSize(8);
        const nameHeight = Math.max(
          12,
          doc.heightOfString(item.name, {
            width: cols.desc.w - 8,
          }),
        );
        const rowH = Math.max(22, nameHeight + 10);

        if (y + rowH > PAGE_H - footerReserve) {
          doc.addPage();
          doc.rect(0, 0, PAGE_W, 6).fill(accent);
          y = 28;
          y = drawTableHeader(y);
        }

        if (index % 2 === 0) {
          doc.rect(M, y, CONTENT_W, rowH).fill('#F9FAFB');
        }

        const textY = y + 6;
        doc.fillColor(ink).font('Helvetica').fontSize(8);
        doc.text(item.name, cols.desc.x + 6, textY, {
          width: cols.desc.w - 8,
        });
        doc.text(String(item.quantity), cols.qty.x, textY, {
          width: cols.qty.w,
          align: 'right',
          lineBreak: false,
        });
        doc.text(money(item.unitPrice, payload.currency), cols.unit.x, textY, {
          width: cols.unit.w,
          align: 'right',
          lineBreak: false,
        });
        doc.text(money(item.totalPrice, payload.currency), cols.amount.x, textY, {
          width: cols.amount.w - 6,
          align: 'right',
          lineBreak: false,
        });

        y += rowH;
      }

      doc
        .moveTo(M, y)
        .lineTo(M + CONTENT_W, y)
        .strokeColor(line)
        .lineWidth(1)
        .stroke();
      y += 16;

      const totalsW = 220;
      const totalsX = M + CONTENT_W - totalsW;
      const totalLabel = isProforma ? 'Amount Payable' : 'Total Paid';
      const totals: Array<{ label: string; value: string; emph?: boolean }> = [
        { label: 'Subtotal', value: money(payload.subtotal, payload.currency) },
        { label: payload.taxLabel ?? 'VAT (16%)', value: money(payload.tax, payload.currency) },
        { label: 'Shipping', value: money(payload.shippingFee, payload.currency) },
        { label: totalLabel, value: money(payload.totalAmount, payload.currency), emph: true },
      ];

      for (const row of totals) {
        if (row.emph) {
          doc.rect(totalsX - 8, y - 4, totalsW + 8, 22).fill(primary);
          doc
            .fillColor('#FFFFFF')
            .font('Helvetica-Bold')
            .fontSize(10)
            .text(row.label, totalsX, y + 2, { width: 100, lineBreak: false });
          doc.text(row.value, totalsX + 100, y + 2, {
            width: totalsW - 100,
            align: 'right',
            lineBreak: false,
          });
          y += 26;
        } else {
          doc
            .fillColor(muted)
            .font('Helvetica')
            .fontSize(9)
            .text(row.label, totalsX, y, { width: 100, lineBreak: false });
          doc
            .fillColor(ink)
            .font('Helvetica')
            .fontSize(9)
            .text(row.value, totalsX + 100, y, {
              width: totalsW - 100,
              align: 'right',
              lineBreak: false,
            });
          y += 14;
        }
      }

      y += 18;

      // Payment / bank instructions — proforma only
      if (isProforma) {
        if (y > PAGE_H - 160) {
          doc.addPage();
          doc.rect(0, 0, PAGE_W, 6).fill(accent);
          y = 28;
        }

        doc
          .fillColor(accent)
          .font('Helvetica-Bold')
          .fontSize(9)
          .text('PAYMENT DETAILS', M, y, { width: CONTENT_W, lineBreak: false });
        y += 14;

        const paymentLines = nonEmpty([
          `Preferred method: ${payload.paymentMethod.replace(/_/g, ' ')}`,
          payload.paymentReference ? `Reference: ${payload.paymentReference}` : null,
          payload.company.bankName ? `Bank: ${payload.company.bankName}` : null,
          payload.company.bankAccountName
            ? `Account name: ${payload.company.bankAccountName}`
            : null,
          payload.company.bankAccountNumber
            ? `Account number: ${payload.company.bankAccountNumber}`
            : null,
          payload.company.bankBranch ? `Branch: ${payload.company.bankBranch}` : null,
        ]);

        doc.fillColor(ink).font('Helvetica').fontSize(8);
        for (const row of paymentLines) {
          doc.text(row, M, y, { width: CONTENT_W, lineBreak: false });
          y += 11;
        }
        y += 10;
      }

      const footerNote = isProforma
        ? isQuote
          ? 'This quotation is valid subject to the expiry date shown and is not a tax invoice or confirmation of payment.'
          : 'This proforma invoice is a quotation for payment. It is not a tax invoice and does not confirm receipt of funds.'
        : payload.company.invoiceFooterNote ||
          'This is a computer-generated tax invoice. Keep for your records and KRA compliance.';

      doc.fillColor(muted).font('Helvetica').fontSize(8);
      doc.text(footerNote, M, y, { width: CONTENT_W, lineGap: 2 });

      const pages = doc.bufferedPageRange();
      for (let i = 0; i < pages.count; i += 1) {
        doc.switchToPage(i);
        doc
          .moveTo(M, PAGE_H - 40)
          .lineTo(M + CONTENT_W, PAGE_H - 40)
          .strokeColor(line)
          .lineWidth(0.5)
          .stroke();
        doc
          .fillColor(muted)
          .font('Helvetica')
          .fontSize(7)
          .text(
            `${payload.company.tradingName}  ·  KRA PIN ${payload.company.kraPin}  ·  ${title}`,
            M,
            PAGE_H - 30,
            { width: CONTENT_W * 0.7, lineBreak: false },
          );
        doc.text(`Page ${i + 1} of ${pages.count}`, M, PAGE_H - 30, {
          width: CONTENT_W,
          align: 'right',
          lineBreak: false,
        });
      }

      doc.end();
    });
  }
}
