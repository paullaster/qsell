import { AGE_BUCKETS, type AgeBucket } from '@/lib/vendor-payment';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { asRecord, readChoice, readYmd } from '../engine/params';
import type { ReportExecutor } from '../engine/run';
import type { ExportTable } from '../export/table';

export const PAYABLES_BASES = ['due', 'invoice'] as const;
export const PAYABLES_GROUPS = ['vendor', 'category', 'posting_group'] as const;

export interface PayablesAgeingParams {
  /** The day the ageing is worked out as of (a real calendar day). */
  asOf: string;
  /** What "late" counts from: the due date or the invoice date. */
  basis: (typeof PAYABLES_BASES)[number];
  /** What one line is: a vendor, a procurement category or a vendor posting group. */
  groupBy: (typeof PAYABLES_GROUPS)[number];
}

interface AgeingOptions {
  basis: PayablesAgeingParams['basis'];
  groupBy: PayablesAgeingParams['groupBy'];
}

/** What the payables report service returns: amounts in cents, in the base currency. */
export interface PayablesAgeingResult {
  asOf: string;
  basis: PayablesAgeingParams['basis'];
  groupBy: PayablesAgeingParams['groupBy'];
  lines: {
    vendorId: string;
    name: string;
    number: string | null;
    currency: string;
    buckets: Record<AgeBucket, number>;
    owedCents: number;
    unappliedCents: number;
    netCents: number;
  }[];
  totals: Record<AgeBucket, number>;
  owedCents: number;
  unappliedCents: number;
}

const GROUP_LABEL: Record<PayablesAgeingParams['groupBy'], string> = {
  vendor: 'Supplier',
  category: 'Category',
  posting_group: 'Posting group',
};

const money = (cents: number): number => cents / 100;

/** The ageing as a table: the buckets in order of lateness, then what is owed, what sits unapplied, and the net. */
export function payablesAgeingTable(data: PayablesAgeingResult): ExportTable {
  return {
    title: 'What we owe',
    columns: [
      { label: GROUP_LABEL[data.groupBy], kind: 'text' },
      { label: 'Number', kind: 'text' },
      { label: 'Currency', kind: 'text' },
      ...AGE_BUCKETS.map((b) => ({ label: b.label, kind: 'money' as const })),
      { label: 'Owed', kind: 'money' },
      { label: 'Unapplied payments and credits', kind: 'money' },
      { label: 'Net', kind: 'money' },
    ],
    // Only a line that is one vendor leads to that vendor's payables.
    rowLinks: data.lines.map((l) =>
      data.groupBy === 'vendor' ? `/admin/vendors/payables/${l.vendorId}` : null,
    ),
    rows: data.lines.map((l) => [
      l.name,
      l.number,
      l.currency,
      ...AGE_BUCKETS.map((b) => money(l.buckets[b.key])),
      money(l.owedCents),
      money(l.unappliedCents),
      money(l.owedCents + l.unappliedCents),
    ]),
    totals: [
      'Total',
      null,
      null,
      ...AGE_BUCKETS.map((b) => money(data.totals[b.key])),
      money(data.owedCents),
      money(data.unappliedCents),
      money(data.owedCents + data.unappliedCents),
    ],
  };
}

/**
 * What we owe, by how late it is, as a report the runner can produce. It calls the same payables ageing query the
 * *What we owe* screen calls. Parameters are read here: a date that is not a real day, or a word that is not one of
 * the allowed ones, falls back to today and to the screen's defaults (the due date, grouped by vendor) instead of
 * reaching the query.
 */
export function payablesAgeingExecutor(deps: {
  companyId: () => Promise<string>;
  today?: () => string;
  payables: {
    ageing(companyId: string, asOf: string, options: AgeingOptions): Promise<PayablesAgeingResult>;
  };
}): ReportExecutor<PayablesAgeingParams, PayablesAgeingResult> {
  const today = deps.today ?? (() => businessDate());
  return {
    code: 'payables-ageing',
    permissions: [],
    readParams: (raw) => {
      const input = asRecord(raw);
      return {
        ok: true,
        params: {
          asOf: readYmd(input.asOf) ?? today(),
          basis: readChoice(input.basis, PAYABLES_BASES) ?? 'due',
          groupBy: readChoice(input.groupBy, PAYABLES_GROUPS) ?? 'vendor',
        },
      };
    },
    execute: async ({ params, wantTable }) => {
      const companyId = await deps.companyId();
      const data = await deps.payables.ageing(companyId, params.asOf, {
        basis: params.basis,
        groupBy: params.groupBy,
      });
      return { data, ...(wantTable ? { table: payablesAgeingTable(data) } : {}) };
    },
  };
}
