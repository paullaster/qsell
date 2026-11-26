import PDFDocument from 'pdfkit';
import { stripControls } from './sanitize';
import { displayText, type ColumnKind, type ExportFacts, type ExportTable } from './table';

const INK = '#111827';
const MUTED = '#6B7280';
const LINE = '#E5E7EB';
const BAND = '#F3F4F6';
const STRIPE = '#FAFAFA';

const MARGIN = 36;
const FOOTER_H = 30;
const WIDE_COLUMNS = 6;
const PAD_X = 4;
const PAD_Y = 4;
const MIN_ROW_H = 17;
const FONT_SIZE = 8.5;
const MAX_CELL_CHARS = 400;
const LOGO_BOX = 44;

type Doc = InstanceType<typeof PDFDocument>;

const isNumeric = (kind: ColumnKind): boolean =>
  kind === 'money' || kind === 'count' || kind === 'percent';

const clip = (text: string): string => {
  const clean = stripControls(text);
  return clean.length > MAX_CELL_CHARS ? `${clean.slice(0, MAX_CELL_CHARS)}…` : clean;
};

/**
 * The table as a PDF: A4, landscape when there are many columns. Page one opens with the business's heading (its name,
 * and whatever of its logo and contact details the company chose to show), then the report's name, the question it
 * answers and the days it covers. The header row repeats on every page, rows grow to fit wrapped text so nothing is cut
 * or printed over its neighbour, numbers are grouped and aligned to the right, and a totals row closes the table. The
 * footer carries who printed it for whom, when, and the page number. Control characters are removed; a PDF cannot run formulas.
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

    const kinds = table.columns.map((c) => c.kind);
    const body = table.rows.map((row) => row.map((cell, i) => clip(displayText(cell, kinds[i] ?? 'text'))));
    const totals = table.totals?.map((cell, i) => clip(displayText(cell, kinds[i] ?? 'text')));
    const labels = table.columns.map((c) => clip(c.label));

    const widths = columnWidths(doc, kinds, labels, body, totals, width);
    const xs = widths.map((_, i) => MARGIN + widths.slice(0, i).reduce((a, b) => a + b, 0));

    const rowHeight = (cells: readonly string[], font: string): number => {
      doc.font(font).fontSize(FONT_SIZE);
      let tallest = 0;
      cells.forEach((text, i) => {
        tallest = Math.max(
          tallest,
          doc.heightOfString(text, { width: (widths[i] ?? 40) - PAD_X * 2 }),
        );
      });
      return Math.max(MIN_ROW_H, tallest + PAD_Y * 2);
    };

    const drawRow = (
      y: number,
      cells: readonly string[],
      opts: { bold?: boolean; fill?: string; rule?: number },
    ): number => {
      const font = opts.bold === true ? 'Helvetica-Bold' : 'Helvetica';
      const h = rowHeight(cells, font);
      if (opts.fill !== undefined) doc.rect(MARGIN, y, width, h).fill(opts.fill);
      doc.fillColor(INK).font(font).fontSize(FONT_SIZE);
      cells.forEach((text, i) => {
        doc.text(text, (xs[i] ?? MARGIN) + PAD_X, y + PAD_Y, {
          width: (widths[i] ?? 40) - PAD_X * 2,
          height: h - PAD_Y,
          align: isNumeric(kinds[i] ?? 'text') ? 'right' : 'left',
        });
      });
      doc
        .moveTo(MARGIN, y + h)
        .lineTo(MARGIN + width, y + h)
        .strokeColor(opts.rule === undefined ? LINE : INK)
        .lineWidth(opts.rule ?? 0.5)
        .stroke();
      return h;
    };

    const header = (y: number): number => drawRow(y, labels, { bold: true, fill: BAND });

    // Page one: the business, then the report.
    let y = drawHeading(doc, facts, width);
    y += header(y);

    const newPage = () => {
      doc.addPage();
      doc
        .fillColor(MUTED)
        .font('Helvetica')
        .fontSize(8.5)
        .text(`${stripControls(facts.reportTitle)} (continued)`, MARGIN, MARGIN, {
          width,
          lineBreak: false,
          ellipsis: true,
        });
      y = MARGIN + 16;
      y += header(y);
    };

    body.forEach((cells, r) => {
      if (y + rowHeight(cells, 'Helvetica') > bottom) newPage();
      y += drawRow(y, cells, r % 2 === 1 ? { fill: STRIPE } : {});
    });
    if (totals !== undefined) {
      if (y + rowHeight(totals, 'Helvetica-Bold') > bottom) newPage();
      y += drawRow(y, totals, { bold: true, rule: 1 });
    }

    // Footer on every page: who it is for and when it was printed, and the page number.
    const range = doc.bufferedPageRange();
    const footer = [
      stripControls(facts.companyName),
      stripControls(facts.reportTitle),
      facts.printedAt === undefined ? '' : `Printed ${stripControls(facts.printedAt)}`,
    ]
      .filter((part) => part !== '')
      .join('   ·   ');
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      doc.fillColor(MUTED).font('Helvetica').fontSize(7.5);
      doc.text(footer, MARGIN, pageH - MARGIN - 12, {
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

/**
 * Column widths that fit the page. Number columns take what their figures need; text columns share what is left, and wrap
 * when they must. A header wraps between words but never inside one.
 */
function columnWidths(
  doc: Doc,
  kinds: readonly ColumnKind[],
  labels: readonly string[],
  body: readonly (readonly string[])[],
  totals: readonly string[] | undefined,
  usable: number,
): number[] {
  const measure = (text: string, font: string): number => {
    doc.font(font).fontSize(FONT_SIZE);
    return doc.widthOfString(text);
  };
  const wants = kinds.map((kind, i) => {
    const cells = [...body.map((r) => r[i] ?? ''), ...(totals === undefined ? [] : [totals[i] ?? ''])];
    const widest = Math.max(0, ...cells.map((c) => measure(c, 'Helvetica-Bold')));
    const label = labels[i] ?? '';
    const longestWord = Math.max(0, ...label.split(/\s+/).map((w) => measure(w, 'Helvetica-Bold')));
    if (isNumeric(kind)) {
      // A heading may take two lines; it takes a third only when a word needs the room.
      const need = Math.max(widest, longestWord, measure(label, 'Helvetica-Bold') / 2 + 4, 30) + PAD_X * 2;
      return { want: need, min: need, flexible: false };
    }
    const full = Math.max(widest, measure(label, 'Helvetica-Bold'));
    return {
      want: full + PAD_X * 2,
      min: Math.max(longestWord, Math.min(widest, 60)) + PAD_X * 2,
      flexible: kind === 'text',
    };
  });
  const sumWant = wants.reduce((a, c) => a + c.want, 0);
  if (sumWant <= usable) {
    const flexTotal = wants.reduce((a, c) => a + (c.flexible ? c.want : 0), 0);
    const spread = usable - sumWant;
    const base = flexTotal > 0 ? flexTotal : sumWant;
    return wants.map((c) => {
      const takes = flexTotal > 0 ? c.flexible : true;
      return c.want + (takes ? (spread * c.want) / base : 0);
    });
  }
  const fixed = wants.reduce((a, c) => a + (c.flexible ? 0 : c.want), 0);
  const budget = usable - fixed;
  const minTotal = wants.reduce((a, c) => a + (c.flexible ? c.min : 0), 0);
  if (budget >= minTotal && minTotal > 0) {
    const room = wants.reduce((a, c) => a + (c.flexible ? c.want - c.min : 0), 0);
    const give = budget - minTotal;
    return wants.map((c) => {
      if (!c.flexible) return c.want;
      return c.min + (room > 0 ? (give * (c.want - c.min)) / room : 0);
    });
  }
  return wants.map((c) => (c.want / sumWant) * usable);
}

/** The top of page one. Returns the y the table starts at. */
function drawHeading(doc: Doc, facts: ExportFacts, width: number): number {
  const brand = facts.brand;
  let textX = MARGIN;
  let y = MARGIN;
  let logoShown = false;
  if (brand?.logoPath !== undefined && brand.logoPath !== null) {
    try {
      doc.image(brand.logoPath, MARGIN, y, { fit: [LOGO_BOX, LOGO_BOX] });
      textX = MARGIN + LOGO_BOX + 10;
      logoShown = true;
    } catch {
      // A logo that cannot be read is left out; the name still heads the page.
    }
  }
  const textW = width - (textX - MARGIN);
  doc
    .fillColor(INK)
    .font('Helvetica-Bold')
    .fontSize(15)
    .text(stripControls(facts.companyName), textX, y, { width: textW });
  y = doc.y + 1;
  const small = (text: string, font = 'Helvetica') => {
    doc.fillColor(MUTED).font(font).fontSize(8.5).text(stripControls(text), textX, y, { width: textW });
    y = doc.y + 1;
  };
  if (brand !== undefined) {
    if (brand.legalName !== null) small(brand.legalName);
    if (brand.tagline !== null) small(brand.tagline, 'Helvetica-Oblique');
    if (brand.address !== null) small(brand.address);
    if (brand.contacts.length > 0) small(brand.contacts.join('   ·   '));
    if (brand.kraPin !== null) small(brand.kraPin);
  }
  if (logoShown) y = Math.max(y, MARGIN + LOGO_BOX);
  y += 8;
  if (brand !== undefined && hasMore(brand)) {
    doc
      .moveTo(MARGIN, y)
      .lineTo(MARGIN + width, y)
      .strokeColor(LINE)
      .lineWidth(0.8)
      .stroke();
    y += 10;
  }

  doc
    .fillColor(INK)
    .font('Helvetica-Bold')
    .fontSize(13)
    .text(stripControls(facts.reportTitle), MARGIN, y, { width });
  y = doc.y + 2;
  doc
    .fillColor(MUTED)
    .font('Helvetica')
    .fontSize(8.5)
    .text(stripControls(facts.question), MARGIN, y, { width });
  y = doc.y + 2;
  const covers = [facts.period ?? '', facts.scope].filter((part) => part !== '').join('   ·   ');
  if (covers !== '') {
    doc.fillColor(INK).font('Helvetica').fontSize(9).text(stripControls(covers), MARGIN, y, { width });
    y = doc.y + 2;
  }
  return y + 10;
}

const hasMore = (brand: NonNullable<ExportFacts['brand']>): boolean =>
  brand.logoPath !== null ||
  brand.legalName !== null ||
  brand.tagline !== null ||
  brand.address !== null ||
  brand.contacts.length > 0 ||
  brand.kraPin !== null;
