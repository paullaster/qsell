import PDFDocument from 'pdfkit';
import { has, orElse } from '@/lib/values';
import type { DeliveryNoteDocument } from '@/server/domains/delivery/delivery-note';
import { resolveLocalLogoPath } from './pdfkit-invoice.adapter';

const INK = '#111827';
const MUTED = '#6B7280';
const LINE = '#E5E7EB';

const nonEmpty = (parts: (string | null | undefined)[]): string[] => parts.filter((p): p is string => has(p));
const qty = (n: number): string => String(Math.round(n * 1000) / 1000);

/**
 * A clear A4 delivery note, drawn from a plain {@link DeliveryNoteDocument}. It travels with the goods: what is to be carried and to
 * whom, with no prices, and a place for the person who receives it to sign. Pure apart from reading the logo file.
 */
export function renderDeliveryNotePdf(note: DeliveryNoteDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const { company } = note;
    const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: `Delivery note ${note.number}`, Author: company.legalName, Subject: `Delivery of order ${note.orderNumber} to ${note.deliverTo.name}` } });
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
    doc.rect(0, 0, W, 6).fill(accent);

    // Company, left; the title and numbers, right.
    let brandX = M;
    const headerY = 28;
    const logo = resolveLocalLogoPath(company.logoUrl);
    if (logo !== null) {
      try {
        doc.image(logo, M, headerY, { fit: [48, 48] });
        brandX = M + 56;
      } catch {
        // A logo that cannot be decoded is left out; the name still heads the page.
      }
    }
    const leftW = CW * 0.55;
    doc.fillColor(primary).font('Helvetica-Bold').fontSize(16).text(orElse(company.tradingName, company.legalName), brandX, headerY, { width: leftW - (brandX - M) });
    let leftY = Math.max(doc.y + 6, logo === null ? 0 : headerY + 52);
    doc.fillColor(MUTED).font('Helvetica').fontSize(8);
    for (const row of nonEmpty([company.streetAddress, [company.city, company.countyOrState].filter(has).join(', '), `Tel: ${orElse(company.tel, company.phone)}`, `Email: ${company.email}`])) {
      doc.text(row, M, leftY, { width: leftW, lineBreak: false });
      leftY += 11;
    }
    const rightW = CW * 0.4;
    const rightX = M + CW - rightW;
    doc.fillColor(accent).font('Helvetica-Bold').fontSize(18).text('DELIVERY NOTE', rightX, headerY, { width: rightW, align: 'right', lineBreak: false });
    let rightY = headerY + 28;
    for (const [label, value] of [['Delivery No.', note.number], ['Order No.', note.orderNumber], ['Printed on', note.printedOn]] as [string, string][]) {
      doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(label, rightX, rightY, { width: rightW * 0.45, lineBreak: false });
      doc.fillColor(INK).font('Helvetica-Bold').text(value, rightX + rightW * 0.45, rightY, { width: rightW * 0.55, align: 'right', lineBreak: false });
      rightY += 13;
    }
    let y = Math.max(leftY, rightY) + 14;
    doc.moveTo(M, y).lineTo(M + CW, y).strokeColor(LINE).lineWidth(1).stroke();
    y += 18;

    // Deliver to, and from.
    const colW = CW / 2 - 10;
    doc.fillColor(accent).font('Helvetica-Bold').fontSize(9).text('DELIVER TO', M, y, { lineBreak: false });
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(12).text(note.deliverTo.name, M, y + 14, { width: colW });
    doc.fillColor(INK).font('Helvetica').fontSize(9);
    let toY = doc.y + 3;
    for (const row of nonEmpty([...note.deliverTo.address, has(note.deliverTo.phone) ? `Tel: ${note.deliverTo.phone}` : null])) {
      doc.text(row, M, toY, { width: colW });
      toY = doc.y + 1;
    }
    if (has(note.deliverTo.instructions)) {
      doc.fillColor(MUTED).fontSize(8).text(`Note: ${note.deliverTo.instructions}`, M, toY + 3, { width: colW });
      toY = doc.y;
    }
    const fromX = M + CW / 2 + 10;
    doc.fillColor(accent).font('Helvetica-Bold').fontSize(9).text(note.method === 'courier' ? 'SENT BY COURIER' : 'FROM', fromX, y, { lineBreak: false });
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(12).text(note.from.branch, fromX, y + 14, { width: colW });
    if (note.courier !== null) {
      doc.fillColor(INK).font('Helvetica').fontSize(9).text(`Courier: ${note.courier.name}`, fromX, doc.y + 3, { width: colW });
      if (has(note.courier.tracking)) doc.text(`Tracking number: ${note.courier.tracking}`, fromX, doc.y + 1, { width: colW });
    }
    y = Math.max(toY, doc.y) + 22;

    // What is carried.
    doc.rect(M, y, CW, 20).fill(primary);
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(8).text('ITEM', M + 8, y + 6, { lineBreak: false });
    doc.text('CODE', M + CW * 0.55, y + 6, { lineBreak: false });
    doc.text('QUANTITY', M, y + 6, { width: CW - 8, align: 'right', lineBreak: false });
    y += 20;
    for (const [i, l] of note.lines.entries()) {
      if (y + 24 > H - 150) {
        doc.addPage();
        y = 42;
      }
      if (i % 2 === 1) doc.rect(M, y, CW, 22).fill('#F9FAFB');
      doc.fillColor(INK).font('Helvetica').fontSize(9).text(l.name, M + 8, y + 6, { width: CW * 0.5, lineBreak: false, ellipsis: true });
      doc.fillColor(MUTED).text(l.sku, M + CW * 0.55, y + 6, { width: CW * 0.25, lineBreak: false, ellipsis: true });
      doc.fillColor(INK).font('Helvetica-Bold').text(qty(l.quantity), M, y + 6, { width: CW - 8, align: 'right', lineBreak: false });
      y += 22;
    }
    doc.moveTo(M, y).lineTo(M + CW, y).strokeColor(LINE).stroke();
    y += 28;

    // Received by.
    if (y + 110 > H - 40) {
      doc.addPage();
      y = 60;
    }
    doc.fillColor(accent).font('Helvetica-Bold').fontSize(9).text('RECEIVED IN GOOD ORDER', M, y, { lineBreak: false });
    y += 22;
    const done = note.receivedBy !== null;
    for (const [label, value, x, w] of [['Name', note.receivedBy ?? '', M, CW * 0.4], ['Signature', '', M + CW * 0.45, CW * 0.3], ['Date', note.deliveredOn ?? '', M + CW * 0.8, CW * 0.2]] as [string, string, number, number][]) {
      if (value !== '') doc.fillColor(INK).font('Helvetica').fontSize(10).text(value, x, y - 14, { width: w, lineBreak: false });
      doc.moveTo(x, y).lineTo(x + w, y).strokeColor(MUTED).lineWidth(0.7).stroke();
      doc.fillColor(MUTED).font('Helvetica').fontSize(7).text(label, x, y + 3, { lineBreak: false });
    }
    if (done) doc.fillColor(MUTED).fontSize(8).text('Delivered. This copy was printed after delivery.', M, y + 24, { width: CW });
    doc.end();
  });
}
