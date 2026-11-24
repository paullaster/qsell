import type { ReportExecutor } from '../engine/run';
import type { ExportTable } from '../export/table';

/** One customer line of the ageing, as the customer ledger service returns it (money as decimal text). */
export interface AgeingRow {
  id: string;
  number: string;
  name: string;
  owed: string;
  credits: string;
  current: string;
  d1_30: string;
  d31_60: string;
  d61_90: string;
  d90_plus: string;
}

export interface AgeingTotals {
  owed: string;
  credits: string;
  current: string;
  d1_30: string;
  d31_60: string;
  d61_90: string;
  d90_plus: string;
}

/** What the customer ledger service returns for the ageing screen. */
export interface AgeingByCustomer {
  rows: AgeingRow[];
  totals: AgeingTotals;
  /** True when the list was cut at the limit it was asked for. */
  truncated: boolean;
}

const n = (text: string): number => Number(text);

/** The ageing as a table: the buckets in order of lateness, then what is owed and what sits unapplied. */
export function receivablesAgeingTable(data: AgeingByCustomer): ExportTable {
  return {
    title: 'Receivables ageing',
    columns: [
      { label: 'Customer', kind: 'text' },
      { label: 'Customer number', kind: 'text' },
      { label: 'Not yet due', kind: 'money' },
      { label: '1–30 days late', kind: 'money' },
      { label: '31–60 days late', kind: 'money' },
      { label: '61–90 days late', kind: 'money' },
      { label: 'Over 90 days late', kind: 'money' },
      { label: 'Owed', kind: 'money' },
      { label: 'Unapplied credits', kind: 'money' },
    ],
    rowLinks: data.rows.map((r) => `/admin/finance/receivables/customer/${r.id}`),
    rows: data.rows.map((r) => [
      r.name,
      r.number,
      n(r.current),
      n(r.d1_30),
      n(r.d31_60),
      n(r.d61_90),
      n(r.d90_plus),
      n(r.owed),
      n(r.credits),
    ]),
    totals: [
      'Total',
      null,
      n(data.totals.current),
      n(data.totals.d1_30),
      n(data.totals.d31_60),
      n(data.totals.d61_90),
      n(data.totals.d90_plus),
      n(data.totals.owed),
      n(data.totals.credits),
    ],
  };
}

/**
 * Receivables ageing as a report the runner can produce. It calls the same customer ledger query the Receivables
 * ageing screen has always called, for the same number of customers, so the figures are unchanged. The company comes
 * from the server, never from the browser. The query itself says whether the list was cut at the limit.
 */
export function receivablesAgeingExecutor(deps: {
  companyId: () => Promise<string>;
  ledger: { ageingByCustomer(companyId: string, limit: number): Promise<AgeingByCustomer> };
}): ReportExecutor<Record<string, never>, AgeingByCustomer> {
  return {
    code: 'receivables-ageing',
    permissions: [],
    readParams: () => ({ ok: true, params: {} }),
    execute: async ({ maxRows, wantTable }) => {
      const companyId = await deps.companyId();
      const data = await deps.ledger.ageingByCustomer(companyId, maxRows);
      return {
        data,
        truncated: data.truncated,
        ...(wantTable ? { table: receivablesAgeingTable(data) } : {}),
      };
    },
  };
}
