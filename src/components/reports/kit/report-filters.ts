import { formatDateRange } from '@/lib/reports/format';
import type { ReportFacts } from '@/server/domains/reports/analysis/types';
import {
  COMPARE_LABELS,
  COMPARE_MODES,
  PERIOD_PRESETS,
  PERIOD_PRESET_LABELS,
  type PeriodPreset,
} from '@/server/domains/reports/period';
import type { FilterState } from './FilterBar';

/** The filter bar's state from the facts a report states about itself. Pure: the same facts give the same bar. */
export function filterStateOf(facts: ReportFacts, updatedLabel: string): FilterState {
  return {
    preset: facts.preset,
    compare: facts.compare,
    branch: facts.branchId === null ? null : { id: facts.branchId, name: facts.scopeLabel },
    fromDate: facts.fromDate,
    toDate: facts.toDate,
    rangeLabel: formatDateRange(facts.fromDate, facts.toDate),
    compareRangeLabel: formatDateRange(facts.previousFromDate, facts.previousToDate),
    scopeLabel: facts.scopeLabel,
    updatedLabel,
    presets: PERIOD_PRESETS.filter((x): x is Exclude<PeriodPreset, 'custom'> => x !== 'custom').map(
      (value) => ({ value, label: PERIOD_PRESET_LABELS[value] }),
    ),
    compareModes: COMPARE_MODES.map((value) => ({ value, label: COMPARE_LABELS[value] })),
    canPickBranch: facts.canPickBranch,
  };
}

/** What the comparison is called in a sentence. */
export function comparisonWords(facts: ReportFacts): string {
  return facts.compare === 'previous_year' ? 'the same period last year' : 'the previous period';
}
