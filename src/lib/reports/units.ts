import type { ColumnKind } from '@/server/domains/reports/export/table';
import {
  DEFAULT_LOCALE,
  formatCompact,
  formatCount,
  formatMoney,
  formatMoneyShort,
  formatPercent,
} from './format';

/**
 * What a number is, so a chart or table can write it the same way everywhere. Passing a unit (data) instead of a
 * formatting function keeps charts usable from server-rendered pages, where functions cannot be handed to the browser.
 */
export type Unit = { kind: 'money'; currency: string } | { kind: 'count' } | { kind: 'percent' };

export interface Formatters {
  /** The exact figure: KES 12,345 */
  value: (n: number) => string;
  /** A short figure for an axis: 12K */
  axis: (n: number) => string;
}

export function formatters(unit: Unit, locale: string = DEFAULT_LOCALE): Formatters {
  switch (unit.kind) {
    case 'money':
      return {
        value: (n) => formatMoney(n, unit.currency, locale),
        axis: (n) => (n === 0 ? '0' : formatMoneyShort(n, '', locale).trim()),
      };
    case 'count':
      return { value: (n) => formatCount(n, locale), axis: (n) => formatCompact(n, locale) };
    case 'percent':
      return {
        value: (n) => formatPercent(n, 1, locale),
        axis: (n) => `${formatCompact(n, locale)}%`,
      };
  }
}

/**
 * One table cell as text, by the column's kind. Money shows two decimals without repeating the currency in every cell (the
 * column heading carries it), counts group thousands, percentages show one decimal, dates and text are written as they are.
 */
export function formatCell(
  cell: string | number | null,
  kind: ColumnKind,
  locale: string = DEFAULT_LOCALE,
): string {
  if (cell === null) return '';
  if (typeof cell === 'string') return cell;
  switch (kind) {
    case 'money':
      return cell.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    case 'count':
      return formatCount(Math.round(cell), locale);
    case 'percent':
      return formatPercent(cell, 1, locale);
    case 'text':
    case 'date':
      return String(cell);
  }
}
