import { safeText } from './sanitize';
import {
  factLines,
  type ColumnKind,
  type ExportCell,
  type ExportFacts,
  type ExportTable,
} from './table';
import { zipFiles } from './zip';

/**
 * The table as a spreadsheet, written without a library: a workbook is a zip of a few XML parts. Two sheets: *Report*
 * (a frozen header row, then the rows, then totals in bold, with numbers kept as numbers and formatted by kind) and
 * *Details* (the facts the file must state about itself). Text is stored as plain text, made safe against formulas,
 * and characters XML cannot carry are removed. The result is checked by reading it back through the platform's own
 * spreadsheet reader in the tests.
 */

const MAX_COLUMN_WIDTH = 60;
const MIN_COLUMN_WIDTH = 9;

// Cell styles, by index in styles.xml below.
const STYLE = {
  plain: 0,
  header: 1,
  money: 2,
  count: 3,
  percent: 4,
  boldText: 5,
  boldMoney: 6,
  boldCount: 7,
  boldPercent: 8,
} as const;

const NUMBER_STYLE: Record<ColumnKind, { normal: number; bold: number }> = {
  text: { normal: STYLE.plain, bold: STYLE.boldText },
  date: { normal: STYLE.plain, bold: STYLE.boldText },
  money: { normal: STYLE.money, bold: STYLE.boldMoney },
  count: { normal: STYLE.count, bold: STYLE.boldCount },
  percent: { normal: STYLE.percent, bold: STYLE.boldPercent },
};

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Column letters for a zero-based index: 0 is A, 26 is AA. */
export function columnName(index: number): string {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

function textCell(ref: string, text: string, style: number): string {
  const value = escapeXml(safeText(text));
  const s = style === STYLE.plain ? '' : ` s="${String(style)}"`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${value}</t></is></c>`;
}

function numberCell(ref: string, n: number, style: number): string {
  return `<c r="${ref}" s="${String(style)}"><v>${String(n)}</v></c>`;
}

function cellXml(ref: string, cell: ExportCell, kind: ColumnKind, bold: boolean): string {
  const style = bold ? NUMBER_STYLE[kind].bold : NUMBER_STYLE[kind].normal;
  if (cell === null) return '';
  return typeof cell === 'number' ? numberCell(ref, cell, style) : textCell(ref, cell, style);
}

function widthOf(text: string): number {
  return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, text.length + 2));
}

/** About how many characters a cell takes on screen (money gains a thousands separator and two decimals). */
function shownLength(cell: ExportCell, kind: ColumnKind): number {
  if (cell === null) return 0;
  if (typeof cell === 'string') return cell.length;
  return kind === 'money' ? cell.toFixed(2).length + 3 : String(cell).length;
}

function sheetXml(table: ExportTable): string {
  const widths = table.columns.map((c) => widthOf(c.label));
  const bump = (row: readonly ExportCell[]) =>
    row.forEach((cell, i) => {
      const kind = table.columns[i]?.kind ?? 'text';
      widths[i] = Math.max(
        widths[i] ?? MIN_COLUMN_WIDTH,
        widthOf('x'.repeat(shownLength(cell, kind))),
      );
    });
  table.rows.forEach(bump);
  if (table.totals !== undefined) bump(table.totals);

  const rows: string[] = [];
  const head = table.columns
    .map((c, i) => textCell(`${columnName(i)}1`, c.label, STYLE.header))
    .join('');
  rows.push(`<row r="1">${head}</row>`);
  table.rows.forEach((row, r) => {
    const n = r + 2;
    rows.push(
      `<row r="${String(n)}">${row.map((cell, i) => cellXml(`${columnName(i)}${String(n)}`, cell, table.columns[i]?.kind ?? 'text', false)).join('')}</row>`,
    );
  });
  if (table.totals !== undefined) {
    const n = table.rows.length + 2;
    rows.push(
      `<row r="${String(n)}">${table.totals.map((cell, i) => cellXml(`${columnName(i)}${String(n)}`, cell, table.columns[i]?.kind ?? 'text', true)).join('')}</row>`,
    );
  }
  const cols = widths
    .map(
      (w, i) =>
        `<col min="${String(i + 1)}" max="${String(i + 1)}" width="${String(w)}" customWidth="1"/>`,
    )
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `<cols>${cols}</cols><sheetData>${rows.join('')}</sheetData></worksheet>`
  );
}

function detailsXml(facts: ExportFacts): string {
  const rows = factLines(facts).map(([label, value], i) => {
    const n = i + 1;
    return `<row r="${String(n)}">${textCell(`A${String(n)}`, label, STYLE.boldText)}${textCell(`B${String(n)}`, value, STYLE.plain)}</row>`;
  });
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<cols><col min="1" max="1" width="24" customWidth="1"/><col min="2" max="2" width="70" customWidth="1"/></cols>' +
    `<sheetData>${rows.join('')}</sheetData></worksheet>`
  );
}

const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0&quot;%&quot;"/></numFmts>' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFF3F4F6"/><bgColor indexed="64"/></patternFill></fill></fills>' +
  '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
  '<border><left/><right/><top/><bottom style="thin"><color rgb="FF9CA3AF"/></bottom><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="9">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>' +
  '<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="4" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>' +
  '<xf numFmtId="3" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>' +
  '<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>' +
  '</cellXfs></styleSheet>';

/** A workbook (bytes) holding the table and its facts. */
export function buildXlsx(table: ExportTable, facts: ExportFacts): Buffer {
  return zipFiles({
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '</Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>',
    'xl/workbook.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="Report" sheetId="1" r:id="rId1"/><sheet name="Details" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>',
    'xl/styles.xml': STYLES_XML,
    'xl/worksheets/sheet1.xml': sheetXml(table),
    'xl/worksheets/sheet2.xml': detailsXml(facts),
  });
}
