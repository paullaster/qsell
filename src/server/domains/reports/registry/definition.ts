import type { MessageId } from '@/lib/reports/messages';
import type { PermissionKey } from '@/server/domains/access-control/permissions';
import type { DimensionCode } from '../catalogue/dimensions';
import type { FamilyCode } from './families';

/**
 * A report, described in code. The registry is the only list of reports: the hub, the command palette, the
 * permission check, the audit and the exports all read it, and a test (`registry.test.ts`) refuses an entry that
 * is incomplete. Describing a report here does not change how it computes; the numbers come from its own service.
 */

export type ReportTier = 'live' | 'rollup' | 'snapshot';
export type ReportScopeKind = 'company' | 'branch' | 'both';

/** What the report reveals, beyond ordinary figures. It decides which extra permission and audit rules apply. */
export type ReportSensitivity = 'normal' | 'cost' | 'personal' | 'bank' | 'pay';

export type ExportFormat = 'csv' | 'xlsx' | 'pdf';

/**
 * How the report is proved against the books. A report with a counterpart in the ledgers declares which control it
 * ties to; one without says why not, so "none" is a stated fact and never a silent gap.
 */
export type TieOut =
  | { kind: 'none'; reason: string }
  | { kind: 'gl'; control: string }
  | { kind: 'subledger'; control: string };

/**
 * `overview` is the Business Overview screen; `table` is a report the generic runner page draws; `legacy` is an
 * existing screen that keeps its own page and is listed here so it is found, permissioned and documented.
 */
export type ReportView = 'overview' | 'table' | 'legacy';

export interface ReportDefinition {
  /** Stable, kebab-case. Appears in addresses, saved views, audit rows and exports. */
  code: string;
  titleId: MessageId;
  /** The one question the report answers, in a sentence. */
  questionId: MessageId;
  family: FamilyCode;
  /** Every one of these is needed to open the report. The server checks them before reading anything. */
  permissions: readonly PermissionKey[];
  /**
   * For a report that mixes ordinary and cost figures: the permission that unlocks the cost figures. The report
   * must withhold them from anyone without it (it computes only the sections the person may see).
   */
  costGatedBy?: PermissionKey;
  /** Measure codes from the catalogue. Empty only for a legacy report that has not been catalogued yet. */
  measures: readonly string[];
  /** The cuts the report offers. Each must be valid for at least one of its measures. */
  dimensions: readonly DimensionCode[];
  tier: ReportTier;
  scope: ReportScopeKind;
  tieOut: TieOut;
  sensitivity: ReportSensitivity;
  exportFormats: readonly ExportFormat[];
  /** The most rows one run returns; more is cut and flagged as truncated. */
  maxRows: number;
  /** The longest one run may take, in milliseconds. */
  timeoutMs: number;
  /** Words people search for, lower case. */
  keywords: readonly string[];
  /** Where the report is documented: a file in `docs/implementor-guide` and a heading in it. */
  docs: { file: string; heading: string };
  view: ReportView;
  /** The screen's own address. Required for `overview` and `legacy`. */
  href?: string;
  /**
   * `pending` is allowed only on a legacy report whose figures are not in the measure catalogue yet. These are listed
   * by a test as work still to do and must reach zero before the slice that rebuilds them is closed.
   */
  catalogue: 'complete' | 'pending';
}
