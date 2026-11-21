import PDFDocument from 'pdfkit';
import { has, orElse } from '@/lib/values';
import type { ShiftReportDocument } from '@/server/domains/selling/shifts/shift-report-document';
import { resolveLocalLogoPath } from './pdfkit-invoice.adapter';

const INK = '#111827';
const MUTED = '#6B7280';
const LINE = '#E5E7EB';
const BAND = '#F3F4F6';

/**
 * A clean A4 shift report (X while open, Z once closed), drawn from a plain {@link ShiftReportDocument}: the shop, the till and who
 * opened and closed it, the cash worked out line by line, what was taken other ways, the count, the cash in and out, and places for the
 * cashier and the supervisor to sign. Pure apart from reading the logo file.
 */
export function renderShiftReportPdf(report: ShiftReportDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const { company } = report;
    const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: `${report.title} ${report.number}`.trim(), Author: company.legalName, Subject: 'Shift report' } });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width;
    const H = doc.page.height;
    const M = 46;
    const CW = W - M * 2;
    const accent = has(company.accentColor) ? company.accentColor : '#4F46E5';
    const primary = has(company.primaryColor) ? company.primaryColor : INK;
    doc.rect(0, 0, W, 6).fill(accent);

    let brandX = M;
    const logo = resolveLocalLogoPath(company.logoUrl);
    if (logo !== null) {
      try {
        doc.image(logo, M, 28, { fit: [48, 48] });
        brandX = M + 58;
      } catch {
        // A logo that cannot be decoded is left out; the name still heads the page.
      }
    }
    doc.fillColor(primary).font('Helvetica-Bold').fontSize(16).text(orElse(company.tradingName, company.legalName), brandX, 30, { width: CW * 0.55, lineBreak: false });
    doc.fillColor(MUTED).font('Helvetica').fontSize(8).text([company.city, company.countyOrState].filter(has).join(', '), brandX, 52, { width: CW * 0.55, lineBreak: false });
    doc.fillColor(accent).font('Helvetica-Bold').fontSize(20).text(report.title, M + CW * 0.5, 28, { width: CW * 0.5, align: 'right', lineBreak: false });
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(11).text(`${report.number}  ·  ${report.status}`, M + CW * 0.5, 54, { width: CW * 0.5, align: 'right', lineBreak: false });
    let y = 88;
    doc.moveTo(M, y).lineTo(M + CW, y).strokeColor(LINE).lineWidth(1).stroke();
    y += 14;

    const ensure = (need: number) => {
      if (y + need > H - 70) {
        doc.addPage();
        doc.rect(0, 0, W, 6).fill(accent);
        y = 36;
      }
    };
    const heading = (text: string) => {
      ensure(40);
      doc.fillColor(accent).font('Helvetica-Bold').fontSize(9).text(text.toUpperCase(), M, y, { lineBreak: false });
      y += 16;
    };
    const row = (label: string, value: string, strong = false, shaded = false) => {
      ensure(20);
      if (shaded) doc.rect(M, y - 3, CW, 18).fill(BAND);
      doc.fillColor(strong ? INK : MUTED).font(strong ? 'Helvetica-Bold' : 'Helvetica').fontSize(strong ? 10.5 : 9.5).text(label, M + 6, y, { width: CW * 0.62, lineBreak: false });
      doc.fillColor(INK).font(strong ? 'Helvetica-Bold' : 'Helvetica').text(value, M + CW * 0.55, y, { width: CW * 0.45 - 6, align: 'right', lineBreak: false });
      y += 18;
    };

    for (const [label, value] of report.meta) {
      doc.fillColor(MUTED).font('Helvetica').fontSize(9).text(label, M, y, { width: 60, lineBreak: false });
      doc.fillColor(INK).font('Helvetica-Bold').text(value, M + 64, y, { width: CW - 64, lineBreak: false });
      y += 14;
    }
    y += 10;

    heading('The cash');
    report.cash.forEach((r) => row(r.label, r.value, r.strong, r.strong));
    y += 8;
    if (report.other.length > 0) {
      heading('Sales and other takings');
      report.other.forEach((r) => row(r.label, r.value));
      y += 8;
    }
    if (report.counted.length > 0) {
      heading('How the drawer was counted');
      report.counted.forEach((r) => row(r.label, r.value));
      y += 8;
    }
    if (report.note !== null) {
      ensure(30);
      doc.fillColor(INK).font('Helvetica-Oblique').fontSize(9.5).text(report.note, M, y, { width: CW });
      y = doc.y + 12;
    }
    if (report.movements.length > 0) {
      heading('Cash in and out');
      for (const m of report.movements) {
        ensure(30);
        doc.fillColor(INK).font('Helvetica-Bold').fontSize(9.5).text(`${m.kind}  ${m.amount}`, M + 6, y, { width: CW * 0.3, lineBreak: false });
        doc.fillColor(INK).font('Helvetica').text(m.reason, M + CW * 0.3, y, { width: CW * 0.7 - 6, lineBreak: false });
        doc.fillColor(MUTED).fontSize(8).text(`${m.by}, ${m.at}`, M + CW * 0.3, y + 11, { width: CW * 0.7 - 6, lineBreak: false });
        y += 28;
      }
      y += 4;
    }

    // Signatures.
    ensure(80);
    y = Math.max(y + 24, y);
    for (const [n, label] of ['Cashier', 'Supervisor'].entries()) {
      const x = M + n * (CW / 2 + 10);
      doc.moveTo(x, y + 28).lineTo(x + CW / 2 - 20, y + 28).strokeColor(MUTED).lineWidth(0.7).stroke();
      doc.fillColor(MUTED).font('Helvetica').fontSize(8.5).text(`${label}: name, signature and date`, x, y + 33, { width: CW / 2 - 20, lineBreak: false });
    }
    doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(`Printed ${report.printedOn}`, M, H - 40, { width: CW, align: 'center', lineBreak: false });
    doc.end();
  });
}
