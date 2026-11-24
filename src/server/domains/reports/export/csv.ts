import { UTF8_BOM, toCsv } from '@/lib/csv';
import { safeText } from './sanitize';
import { cellText, factLines, type ExportFacts, type ExportTable } from './table';

/**
 * The table as CSV: a byte-order mark so Excel reads accents, CRLF line ends, the column labels, the rows, a totals row
 * when there is one, and under a blank line the facts the file must state about itself. Text is made safe against
 * formula injection; numbers are written plainly (money with two decimals, so a spreadsheet reads them as numbers).
 */
export function buildCsv(table: ExportTable, facts: ExportFacts): string {
  const header = table.columns.map((c) => safeText(c.label));
  const draw = (row: readonly (string | number | null)[]) =>
    row.map((cell, i) => {
      const kind = table.columns[i]?.kind ?? 'text';
      return typeof cell === 'string' ? safeText(cell) : cellText(cell, kind);
    });
  const rows: string[][] = [header, ...table.rows.map(draw)];
  if (table.totals !== undefined) rows.push(draw(table.totals));
  rows.push([]);
  for (const [label, value] of factLines(facts)) rows.push([safeText(label), safeText(value)]);
  return UTF8_BOM + toCsv(rows);
}
