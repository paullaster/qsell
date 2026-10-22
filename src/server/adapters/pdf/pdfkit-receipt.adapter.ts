import PDFDocument from 'pdfkit';
import { has, orElse } from '@/lib/values';
import type { ReceiptDocument } from '@/server/domains/finance/receivables/receipt-document';
import { resolveLocalLogoPath } from './pdfkit-invoice.adapter';

const INK = '#111827';
const MUTED = '#6B7280';
const LINE = '#E5E7EB';

const money = (amount: string, currency: string): string =>
  `${currency} ${Number(amount).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const nonEmpty = (parts: (string | null | undefined)[]): string[] => parts.filter((p): p is string => has(p));

/** A clear A4 payment receipt, drawn from a plain {@link ReceiptDocument}; pure apart from reading the logo file. */
export function renderReceiptPdf(receipt: ReceiptDocument, generatedOn: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const { company } = receipt;
    const doc = new PDFDocument({
      size: 'A4',
      margin: 0,
      info: { Title: `Receipt ${receipt.number}`, Author: company.legalName, Subject: `Payment received from ${receipt.customer.name}` },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width;
    const H = doc.page.height;
    const M = 42;
    const CW = W - M * 2;
    const primary = has(company.primaryColor) ? company.primaryColor : INK;
    const accent = has(company.accentColor) ? company.accentColor : '#4F46E5';
    const reversed = receipt.status === 'reversed';

    const bar = () => doc.rect(0, 0, W, 6).fill(accent);
    bar();

    // Company, left; the document title and numbers, right.
    let brandX = M;
    const logo = resolveLocalLogoPath(company.logoUrl);
    if (logo !== null) {
      try {
        doc.image(logo, M, 28, { fit: [48, 48] });
        brandX = M + 56;
      } catch {
        // A logo that cannot be decoded is left out; the name still heads the page.
      }
    }
    const leftW = CW * 0.55;
    doc.fillColor(primary).font('Helvetica-Bold').fontSize(16).text(orName(company), brandX, 28, { width: leftW - (brandX - M) });
    let leftY = Math.max(doc.y + 6, logo === null ? 0 : 80);
    doc.fillColor(MUTED).font('Helvetica').fontSize(8);
    for (const row of nonEmpty([
      company.legalName !== company.tradingName ? company.legalName : null,
      company.streetAddress,
      [company.city, company.countyOrState, company.postalCode].filter(has).join(', '),
      company.country,
      `Tel: ${orElse(company.tel, company.phone)}`,
      `Email: ${company.email}`,
      has(company.kraPin) ? `KRA PIN: ${company.kraPin}` : null,
    ])) {
      doc.text(row, M, leftY, { width: leftW, lineBreak: false });
      leftY += 11;
    }

    const rightW = CW * 0.4;
    const rightX = M + CW - rightW;
    doc.fillColor(accent).font('Helvetica-Bold').fontSize(18).text('PAYMENT RECEIPT', rightX, 28, { width: rightW, align: 'right', lineBreak: false });
    let rightY = 56;
    for (const [label, value] of [
      ['Receipt No.', receipt.number],
      ['Payment date', receipt.paymentDate],
      ['Posted on', receipt.postingDate],
    ] as [string, string][]) {
      doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(label, rightX, rightY, { width: rightW * 0.45, lineBreak: false });
      doc.fillColor(INK).font('Helvetica-Bold').text(value, rightX + rightW * 0.45, rightY, { width: rightW * 0.55, align: 'right', lineBreak: false });
      rightY += 13;
    }

    let y = Math.max(leftY, rightY) + 14;
    doc.moveTo(M, y).lineTo(M + CW, y).strokeColor(LINE).lineWidth(1).stroke();
    y += 18;

    // Received from, and the amount in a box.
    doc.fillColor(accent).font('Helvetica-Bold').fontSize(9).text('RECEIVED FROM', M, y, { lineBreak: false });
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(12).text(receipt.customer.name, M, y + 14, { width: CW * 0.5 });
    doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(`Customer ${receipt.customer.number}`, M, doc.y + 2, { width: CW * 0.5, lineBreak: false });
    const boxW = CW * 0.4;
    doc.roundedRect(M + CW - boxW, y - 2, boxW, 52, 4).fill('#F3F4F6');
    doc.fillColor(MUTED).font('Helvetica').fontSize(8).text('AMOUNT RECEIVED', M + CW - boxW + 12, y + 6, { lineBreak: false });
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(17).text(money(receipt.amount, receipt.currency), M + CW - boxW + 12, y + 20, { width: boxW - 24, lineBreak: false });
    y = Math.max(doc.y, y + 52) + 20;

    // Facts about the payment.
    const facts: [string, string][] = [
      ['Payment method', receipt.method],
      ...(has(receipt.reference) ? [['Reference', receipt.reference] as [string, string]] : []),
      ...(has(receipt.payer) ? [['Paid by', receipt.payer] as [string, string]] : []),
      ...(receipt.cheque === null
        ? []
        : [['Cheque', nonEmpty([`No. ${receipt.cheque.number}`, receipt.cheque.bank, receipt.cheque.drawer, receipt.cheque.date]).join(' · ')] as [string, string]]),
      ...(receipt.rate === null ? [] : [['Exchange rate', `1 ${receipt.currency} = ${receipt.rate} (base currency)`] as [string, string]]),
      ...(has(receipt.narration) ? [['Note', receipt.narration] as [string, string]] : []),
      ...(has(receipt.receivedBy) ? [['Received by', receipt.receivedBy] as [string, string]] : []),
    ];
    for (const [label, value] of facts) {
      doc.fillColor(MUTED).font('Helvetica').fontSize(9).text(label, M, y, { width: 110, lineBreak: false });
      doc.fillColor(INK).font('Helvetica').fontSize(9).text(value, M + 120, y, { width: CW - 120 });
      y = Math.max(doc.y, y + 12) + 5;
    }

    // What the payment settled.
    y += 8;
    doc.fillColor(accent).font('Helvetica-Bold').fontSize(9).text(receipt.isDeposit ? 'ADVANCE PAYMENT' : 'APPLIED TO', M, y, { lineBreak: false });
    y += 14;
    if (receipt.isDeposit) {
      doc.fillColor(INK).font('Helvetica').fontSize(9).text('Kept on the customer’s account as an advance, to be used on later purchases.', M, y, { width: CW });
      y = doc.y + 6;
    } else if (receipt.applications.length === 0) {
      doc.fillColor(INK).font('Helvetica').fontSize(9).text('Not applied to an invoice yet; held on the customer’s account.', M, y, { width: CW });
      y = doc.y + 6;
    } else {
      doc.rect(M, y, CW, 20).fill(primary);
      doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(8).text('INVOICE', M + 8, y + 6, { lineBreak: false });
      doc.text('AMOUNT', M, y + 6, { width: CW - 8, align: 'right', lineBreak: false });
      y += 20;
      for (const [i, a] of receipt.applications.entries()) {
        if (y + 22 > H - 120) {
          doc.addPage();
          bar();
          y = 30;
        }
        if (i % 2 === 0) doc.rect(M, y, CW, 20).fill('#F9FAFB');
        doc.fillColor(INK).font('Helvetica').fontSize(9).text(a.invoiceNo, M + 8, y + 6, { lineBreak: false });
        doc.text(money(a.amount, receipt.currency), M, y + 6, { width: CW - 8, align: 'right', lineBreak: false });
        y += 20;
      }
      y += 6;
    }
    if (Number(receipt.unapplied) > 0 && !receipt.isDeposit) {
      doc.fillColor(MUTED).font('Helvetica').fontSize(9).text(`Not yet applied to an invoice: ${money(receipt.unapplied, receipt.currency)}`, M, y, { width: CW });
    }

    // Footer.
    const footerY = H - 78;
    doc.moveTo(M, footerY).lineTo(M + CW, footerY).strokeColor(LINE).lineWidth(1).stroke();
    doc.fillColor(MUTED).font('Helvetica').fontSize(8);
    doc.text(has(company.invoiceFooterNote) ? company.invoiceFooterNote : 'Thank you for your payment.', M, footerY + 10, { width: CW });
    doc.text(`This receipt was produced by ${orName(company)} on ${generatedOn}. Keep it as proof of payment.`, M, H - 40, { width: CW, lineBreak: false });

    if (reversed) {
      // A reversed receipt is no longer proof of payment, and must say so on its face.
      doc.save();
      doc.rotate(-30, { origin: [W / 2, H / 2] });
      doc.fillColor('#B91C1C').opacity(0.18).font('Helvetica-Bold').fontSize(90).text('REVERSED', 0, H / 2 - 45, { width: W, align: 'center', lineBreak: false });
      doc.restore();
      doc.fillColor('#B91C1C').opacity(1).font('Helvetica-Bold').fontSize(9).text(
        `THIS RECEIPT WAS REVERSED${has(receipt.reversedOn) ? ` ON ${receipt.reversedOn}` : ''} AND IS NO LONGER VALID AS PROOF OF PAYMENT.`,
        M, footerY - 18, { width: CW, lineBreak: false },
      );
    }
    doc.end();
  });
}

const orName = (c: ReceiptDocument['company']): string => (has(c.tradingName) ? c.tradingName : c.legalName);
