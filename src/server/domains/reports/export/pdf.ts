import PDFDocument from 'pdfkit';
import { stripControls } from './sanitize';
import { cellText, factLines, type ExportFacts, type ExportTable } from './table';

const INK = '#111827';
const MUTED = '#6B7280';
const LINE = '#E5E7EB';
const BAND = '#F3F4F6';

const MARGIN = 36;
const HEADER_H = 22;
const ROW_H = 17;
const FOOTER_H = 30;
const WIDE_COLUMNS = 6;

/**
 * The table as a PDF: A4, landscape when there are many columns, the company and report name on top, the question the
 * report answers, a header row that repeats on every page, numbers aligned to the right, a totals row in bold, and a
 * footer with the facts the file must state (as of, scope, definitions version) and the page number. Text is cut with an
 * ellipsis rather than overflowing its cell. Control characters are removed; a PDF cannot run formulas.
 */
export function buildPdf(table: ExportTable, facts: ExportFacts): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const landscape = table.columns.length > WIDE_COLUMNS;
    const doc = new PDFDocument({
      size: 'A4',
      layout: landscape ? 'landscape' : 'portrait',
      margin: MARGIN,
      bufferPages: true,
      info: {
        Title: stripControls(facts.reportTitle),
        Author: stripControls(facts.companyName),
        Subject: stripControls(facts.question),
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    doc.on('error', reject);

    const pageW = doc.page.width;
    const pageH = doc.page.height;
    const width = pageW - MARGIN * 2;
    const bottom = pageH - MARGIN - FOOTER_H;

    // Column widths follow the longest text in each column (capped), scaled to the page.
    const weights = table.columns.map((c, i) => {
      const longest = Math.max(
        c.label.length,
        ...table.rows.map((r) => cellText(r[i] ?? null, c.kind).length),
        ...(table.totals === undefined ? [0] : [cellText(table.totals[i] ?? null, c.kind).length]),
      );
      return Math.min(40, Math.max(6, longest));
    });
    const total = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((w) => (w / total) * width);
    const xs = widths.map((_, i) => MARGIN + widths.slice(0, i).reduce((a, b) => a + b, 0));

    const drawRow = (
      y: number,
      cells: readonly string[],
      opts: { bold?: boolean; band?: boolean; header?: boolean },
    ) => {
      if (opts.band === true || opts.header === true)
        doc
          .rect(MARGIN, y, width, opts.header === true ? HEADER_H : ROW_H)
          .fill(opts.header === true ? BAND : '#FAFAFA');
      doc
        .fillColor(INK)
        .font(opts.bold === true || opts.header === true ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(8.5);
      cells.forEach((text, i) => {
        const kind = table.columns[i]?.kind ?? 'text';
        const right = kind !== 'text' && kind !== 'date';
        doc.text(stripControls(text), (xs[i] ?? MARGIN) + 3, y + (opts.header === true ? 7 : 4.5), {
          width: (widths[i] ?? 40) - 6,
          align: right ? 'right' : 'left',
          lineBreak: false,
          ellipsis: true,
        });
      });
      const h = opts.header === true ? HEADER_H : ROW_H;
      doc
        .moveTo(MARGIN, y + h)
        .lineTo(MARGIN + width, y + h)
        .strokeColor(LINE)
        .lineWidth(0.5)
        .stroke();
    };

    const heading = () => {
      doc
        .fillColor(INK)
        .font('Helvetica-Bold')
        .fontSize(15)
        .text(stripControls(facts.companyName), MARGIN, MARGIN, { width, lineBreak: false });
      doc
        .fillColor(INK)
        .font('Helvetica-Bold')
        .fontSize(12)
        .text(stripControls(facts.reportTitle), MARGIN, MARGIN + 22, { width, lineBreak: false });
      doc
        .fillColor(MUTED)
        .font('Helvetica')
        .fontSize(8.5)
        .text(stripControls(facts.question), MARGIN, MARGIN + 40, {
          width,
          lineBreak: false,
          ellipsis: true,
        });
      return MARGIN + 60;
    };

    let y = heading();
    drawRow(
      y,
      table.columns.map((c) => c.label),
      { header: true },
    );
    y += HEADER_H;

    const newPage = () => {
      doc.addPage();
      y = MARGIN;
      drawRow(
        y,
        table.columns.map((c) => c.label),
        { header: true },
      );
      y += HEADER_H;
    };

    table.rows.forEach((row, r) => {
      if (y + ROW_H > bottom) newPage();
      drawRow(
        y,
        row.map((cell, i) => cellText(cell, table.columns[i]?.kind ?? 'text')),
        { band: r % 2 === 1 },
      );
      y += ROW_H;
    });
    if (table.totals !== undefined) {
      if (y + ROW_H > bottom) newPage();
      drawRow(
        y,
        table.totals.map((cell, i) => cellText(cell, table.columns[i]?.kind ?? 'text')),
        { bold: true },
      );
      y += ROW_H;
    }

    // Footer on every page: the facts, and the page number.
    const range = doc.bufferedPageRange();
    const footer = factLines(facts)
      .filter(
        ([label]) =>
          label === 'Figures as of' || label === 'Scope' || label === 'Definitions version',
      )
      .map(([label, value]) => `${label}: ${value}`)
      .join('   |   ');
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      doc.fillColor(MUTED).font('Helvetica').fontSize(7.5);
      doc.text(stripControls(footer), MARGIN, pageH - MARGIN - 12, {
        width: width - 80,
        lineBreak: false,
        ellipsis: true,
      });
      doc.text(
        `Page ${String(i + 1)} of ${String(range.count)}`,
        pageW - MARGIN - 80,
        pageH - MARGIN - 12,
        { width: 80, align: 'right', lineBreak: false },
      );
    }
    doc.end();
  });
}
