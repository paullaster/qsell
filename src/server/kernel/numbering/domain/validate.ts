import { validateTemplate } from './template';
import { isIsoDate } from './period';
import { MAX_DIGITS, type Issue, type LineConfig, type SeriesMode } from './types';

import { has } from '@/lib/values';

export interface SeriesRules {
  mode: SeriesMode;
  dateOrder: boolean;
}

/** Configuration problems for one line, in words an admin can act on. Empty means valid. */
export function validateLine(line: Omit<LineConfig, 'id' | 'lineNo'>, rules: SeriesRules): Issue[] {
  const issues: Issue[] = [];
  const add = (field: string, message: string) => issues.push({ field, message });

  if (!isIsoDate(line.startsOn)) add('startsOn', 'Enter a valid start date.');
  if (line.endsOn !== null) {
    if (!isIsoDate(line.endsOn)) add('endsOn', 'Enter a valid end date.');
    else if (isIsoDate(line.startsOn) && line.endsOn < line.startsOn) {
      add('endsOn', 'The end date cannot be before the start date.');
    }
  }
  for (const field of ['prefix', 'suffix'] as const) {
    const problem = validateTemplate(line[field]);
    if (has(problem)) add(field, problem);
  }
  if (!Number.isInteger(line.digits) || line.digits < 1 || line.digits > MAX_DIGITS) {
    add('digits', `Digits must be between 1 and ${MAX_DIGITS}.`);
  }
  if (!Number.isInteger(line.startNo) || line.startNo < 0)
    add('startNo', 'The starting number must be zero or more.');
  if (!Number.isInteger(line.increment) || line.increment < 1 || line.increment > 1000) {
    add('increment', 'The increment must be between 1 and 1000.');
  }
  const capacity = 10 ** Math.min(Math.max(line.digits, 1), MAX_DIGITS) - 1;
  if (line.startNo > capacity)
    add('startNo', `The starting number does not fit in ${line.digits} digits.`);
  if (line.endNo !== null) {
    if (!Number.isInteger(line.endNo)) add('endNo', 'The ending number must be a whole number.');
    else if (line.endNo < line.startNo)
      add('endNo', 'The ending number cannot be below the starting number.');
    else if (line.endNo > capacity)
      add('endNo', `The ending number does not fit in ${line.digits} digits.`);
  }
  if (line.warnAt !== null) {
    if (line.warnAt < line.startNo || (line.endNo !== null && line.warnAt > line.endNo)) {
      add('warnAt', 'The warning number must be inside the range.');
    }
  }
  if (rules.dateOrder && rules.mode !== 'gap_free') {
    add('dateOrder', 'Date order can only be enforced on a gap-free series.');
  }
  return issues;
}

type Scope = Pick<LineConfig, 'id' | 'branchId' | 'startsOn' | 'endsOn' | 'isOpen' | 'lineNo'>;

/**
 * The open line (if any) that would make the choice ambiguous: same branch scope, with a date
 * range that overlaps. Closed lines cannot be chosen, so they never conflict.
 */
export function findOverlap(
  existing: Scope[],
  candidate: Omit<Scope, 'lineNo'> & { lineNo?: number },
): Scope | null {
  if (!candidate.isOpen) return null;
  const aEnd = candidate.endsOn ?? '9999-12-31';
  for (const other of existing) {
    if (other.id === candidate.id || !other.isOpen) continue;
    if (other.branchId !== candidate.branchId) continue;
    const bEnd = other.endsOn ?? '9999-12-31';
    if (candidate.startsOn <= bEnd && other.startsOn <= aEnd) return other;
  }
  return null;
}

/** Fields that may not change once a line has issued a number: they would change meaning. */
export const FROZEN_AFTER_USE = [
  'prefix',
  'suffix',
  'digits',
  'startNo',
  'increment',
  'reset',
  'branchId',
] as const;

export function frozenViolations(existing: LineConfig, patch: Partial<LineConfig>): Issue[] {
  const issues: Issue[] = [];
  for (const field of FROZEN_AFTER_USE) {
    if (field in patch && patch[field] !== existing[field]) {
      issues.push({
        field,
        message:
          'This cannot change once the line has issued numbers. Close the line and add a new one instead.',
      });
    }
  }
  return issues;
}
