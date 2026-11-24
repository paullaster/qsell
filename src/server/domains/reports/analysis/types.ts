import type { Unit } from '@/lib/reports/units';
import type { ExportTable } from '../export/table';

/**
 * What a report that is drawn by the generic report page hands back. Plain data only (no functions, no dates as objects),
 * so it can cross from the server to the browser and be cached. Two shapes exist: an `analysis` (headline figures, charts,
 * a table with drill-down links) and a `statement` (a financial statement with its lines, columns and proofs).
 */

/** The period, the comparison and the scope a report was run for, in the words the filter bar shows. */
export interface ReportFacts {
  preset: string;
  compare: string;
  /** Inclusive local dates. */
  fromDate: string;
  toDate: string;
  previousFromDate: string;
  previousToDate: string;
  timeZone: string;
  baseCurrency: string;
  scopeLabel: string;
  /** The branch chosen, or null for every branch the person may see. */
  branchId: string | null;
  /** True for someone allowed to choose a branch. */
  canPickBranch: boolean;
  /** True for a report about stock or balances as they are right now: it has no period, so none is offered. */
  asAtNow?: boolean;
  /** Set when the period asked for could not be used and another was. */
  notice: string | null;
}

export interface Kpi {
  key: string;
  label: string;
  value: number | null;
  unit: Unit;
  /** The same figure for the comparison period. Null or missing when there is nothing to compare with. */
  previous?: number | null;
  /** True when a rise is good news (false for costs, returns, overdue money). */
  upIsGood?: boolean;
  note?: string;
}

export type ChartSpec =
  | {
      kind: 'line';
      title: string;
      categories: string[];
      series: { key: string; label: string; values: (number | null)[]; dashed?: boolean }[];
      unit: Unit;
    }
  | {
      kind: 'bars';
      title: string;
      categories: string[];
      series: { key: string; label: string; values: (number | null)[] }[];
      unit: Unit;
      stacked?: boolean;
    }
  | {
      kind: 'ranked';
      title: string;
      items: {
        key: string;
        label: string;
        value: number;
        note?: string;
        changePct?: number | null;
        href?: string;
      }[];
      unit: Unit;
    }
  | {
      kind: 'donut';
      title: string;
      items: { key: string; label: string; value: number }[];
      unit: Unit;
      centerLabel: string;
    };

/** A row-level link: where a click on row `i` of the table goes. */
export type RowLinks = readonly (string | null)[];

export interface AnalysisReport {
  kind: 'analysis';
  facts: ReportFacts;
  kpis: Kpi[];
  charts: ChartSpec[];
  table: ExportTable;
  /** Same length as `table.rows`. Null where a row leads nowhere. */
  rowLinks: RowLinks;
  /** How this report adds up to the figure on the Business Overview, as label and amount lines. */
  reconciliation: { label: string; value: number; strong?: boolean }[];
  /** Sentences that say what is and is not counted. */
  notes: string[];
  /** True when more rows existed than the report returns. */
  truncated: boolean;
}

export interface StatementLine {
  key: string;
  label: string;
  /** 0 for a main heading, 1 and 2 for what sits under it. */
  indent: 0 | 1 | 2;
  kind: 'heading' | 'line' | 'subtotal' | 'total';
  /** One figure per column of the statement; null leaves a cell empty (a heading has none). */
  values: (number | null)[];
  /** Per column: the same figure as a share of a base (such as net sales), when the statement offers it. */
  shares?: (number | null)[];
  /** Where a click goes (the ledger entries behind the line). */
  href?: string;
}

export interface StatementCheck {
  key: string;
  label: string;
  ok: boolean;
  /** The two sides in words, so a difference can be seen. */
  detail: string;
}

export interface StatementReport {
  kind: 'statement';
  facts: ReportFacts;
  /** For a statement of a date (a balance sheet) the filter bar offers one date instead of a period. */
  basis: 'period' | 'date';
  columns: { key: string; label: string; sublabel?: string; kind: 'money' | 'percent' }[];
  lines: StatementLine[];
  checks: StatementCheck[];
  kpis: Kpi[];
  notes: string[];
  /** The statement as a flat table, for downloads. */
  table: ExportTable;
}

export type ReportBody = AnalysisReport | StatementReport;
