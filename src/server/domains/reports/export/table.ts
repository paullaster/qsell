/**
 * What an export is made of: one table of typed cells, and the facts that must travel with it. A report builds this
 * once; the CSV, spreadsheet and PDF writers only draw it, so the three always agree and a figure is never worked out
 * twice. Numbers stay numbers until the very end (a money cell is 1234.5, not "KES 1,234.50"), so a spreadsheet can
 * add them up.
 */

export type ExportCell = string | number | null;

export type ColumnKind = 'text' | 'money' | 'count' | 'percent' | 'date';

export interface ExportColumn {
  label: string;
  kind: ColumnKind;
}

export interface ExportTable {
  /** Names the sheet and the file. */
  title: string;
  columns: readonly ExportColumn[];
  rows: readonly (readonly ExportCell[])[];
  /** An optional last row of totals, drawn apart and in bold. */
  totals?: readonly ExportCell[];
  /** Where a click on a row goes, when the table is shown on screen. Downloaded files ignore it. */
  rowLinks?: readonly (string | null)[];
}

/** The business's identity as a download's heading prints it: only what was chosen, with the logo as a file on disk. */
export interface ExportBrand {
  name: string;
  legalName: string | null;
  tagline: string | null;
  address: string | null;
  contacts: readonly string[];
  kraPin: string | null;
  logoPath: string | null;
}

/** What every export states about itself, so a file found in a mailbox a year later can be understood. */
export interface ExportFacts {
  companyName: string;
  reportTitle: string;
  question: string;
  /** ISO instant the figures were produced. */
  asOf: string;
  /** "All branches", a branch name, or empty when the report is company-wide. */
  scope: string;
  definitionsVersion: string;
  /** The days the figures cover, or "As at ..." for a report of a position, in words. */
  period?: string;
  /** When the file was made, in the business's time zone, in words. */
  printedAt?: string;
  /** The heading of the PDF. Without it the page is headed by the company name alone. */
  brand?: ExportBrand;
}

/** The facts as label and value pairs, in the order every format prints them. */
export function factLines(facts: ExportFacts): [string, string][] {
  const lines: [string, string][] = [
    ['Company', facts.companyName],
    ['Report', facts.reportTitle],
    ['Question answered', facts.question],
  ];
  if (facts.period !== undefined && facts.period !== '') lines.push(['Period', facts.period]);
  lines.push(['Figures as of', facts.asOf]);
  if (facts.scope !== '') lines.push(['Scope', facts.scope]);
  lines.push(['Definitions version', facts.definitionsVersion]);
  return lines;
}

/** Problems that would make a table unsafe to write (empty list when it is fine). */
export function tableProblems(table: ExportTable): string[] {
  const out: string[] = [];
  if (table.columns.length === 0) out.push('the table has no columns');
  const width = table.columns.length;
  const check = (row: readonly ExportCell[], name: string) => {
    if (row.length !== width)
      out.push(`${name} has ${String(row.length)} cells but there are ${String(width)} columns`);
    for (const cell of row) {
      if (typeof cell === 'number' && !Number.isFinite(cell))
        out.push(`${name} has a number that is not finite`);
    }
  };
  table.rows.forEach((row, i) => {
    check(row, `row ${String(i + 1)}`);
  });
  if (table.totals !== undefined) check(table.totals, 'the totals row');
  return out;
}

const GROUPED = new Intl.NumberFormat('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const WHOLE = new Intl.NumberFormat('en-KE', { maximumFractionDigits: 0 });
const ONE_DECIMAL = new Intl.NumberFormat('en-KE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** A number as a person reads it on paper: thousands separated, money to the cent, a percentage with its sign. */
export function displayText(cell: ExportCell, kind: ColumnKind): string {
  if (cell === null) return '';
  if (typeof cell === 'string') return cell;
  switch (kind) {
    case 'money':
      return GROUPED.format(cell);
    case 'count':
      return WHOLE.format(cell);
    case 'percent':
      return `${ONE_DECIMAL.format(cell)}%`;
    case 'text':
    case 'date':
      return String(cell);
  }
}

/** A number as text for a plain-text format (CSV), by the column's kind. Spreadsheets keep the number itself. */
export function cellText(cell: ExportCell, kind: ColumnKind): string {
  if (cell === null) return '';
  if (typeof cell === 'string') return cell;
  switch (kind) {
    case 'money':
      return cell.toFixed(2);
    case 'count':
      return String(Math.round(cell));
    case 'percent':
      return cell.toFixed(1);
    case 'text':
    case 'date':
      return String(cell);
  }
}
