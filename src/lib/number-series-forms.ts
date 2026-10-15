import { formatNumber } from '@/server/kernel/numbering/domain/format';
import { emptyToNull, orElse } from '@/lib/values';

export type ResetPolicy = 'never' | 'yearly' | 'monthly';
export type SeriesMode = 'gap_free' | 'allow_gaps';

export const RESET_CHOICES: readonly { id: ResetPolicy; label: string }[] = [
  { id: 'never', label: 'Never' },
  { id: 'yearly', label: 'Every year' },
  { id: 'monthly', label: 'Every month' },
];

export const MODE_CHOICES: readonly { id: SeriesMode; label: string; hint: string }[] = [
  { id: 'gap_free', label: 'Gap-free', hint: 'No missing numbers. Required for fiscal documents.' },
  { id: 'allow_gaps', label: 'Allow gaps', hint: 'Faster for high volume; a restart can skip numbers.' },
];

export const resetLabel = (reset: ResetPolicy): string => RESET_CHOICES.find((c) => c.id === reset)?.label ?? reset;

/** The words under a series' name and in lists: which documents it numbers. */
export function boundWords(bound: readonly { label: string; branchCode: string | null }[]): string {
  return bound.map((b) => (b.branchCode === null ? b.label : `${b.label} (${b.branchCode})`)).join(', ');
}

/** What a number would look like, or nothing when the pattern cannot be written. */
export function exampleNumber(
  line: { prefix: string; suffix: string; digits: number },
  seq: number,
  date: string,
  branchCode: string | null,
  today: string,
): string | null {
  try {
    return formatNumber(line, seq, { date: orElse(date, today), branchCode: branchCode ?? 'NBO' });
  } catch {
    return null;
  }
}

export interface LineFormState {
  branchId: string;
  startsOn: string;
  endsOn: string;
  prefix: string;
  suffix: string;
  digits: string;
  startNo: string;
  endNo: string;
  increment: string;
  warnAt: string;
  reset: ResetPolicy;
}

export interface LineLike {
  branchId: string | null;
  startsOn: string;
  endsOn: string | null;
  prefix: string;
  suffix: string;
  digits: number;
  startNo: number;
  endNo: number | null;
  increment: number;
  warnAt: number | null;
  reset: ResetPolicy;
}

const text = (n: number | null | undefined): string => (n === null || n === undefined ? '' : String(n));

/** A line's form, filled from the line being edited or, for a new one, from sensible starting values. */
export function lineFormFrom(line: LineLike | null, today: string): LineFormState {
  return {
    branchId: line?.branchId ?? '',
    startsOn: line?.startsOn ?? `${today.slice(0, 4)}-01-01`,
    endsOn: line?.endsOn ?? '',
    prefix: line?.prefix ?? '',
    suffix: line?.suffix ?? '',
    digits: String(line?.digits ?? 6),
    startNo: String(line?.startNo ?? 1),
    endNo: text(line?.endNo),
    increment: String(line?.increment ?? 1),
    warnAt: text(line?.warnAt),
    reset: line?.reset ?? 'yearly',
  };
}

const optionalNumber = (value: string): number | null => (value.trim() === '' ? null : Number(value));

/** The form as it is sent to the server (the server checks every field again). */
export function lineValues(f: LineFormState) {
  return {
    branchId: emptyToNull(f.branchId),
    startsOn: f.startsOn,
    endsOn: emptyToNull(f.endsOn),
    prefix: f.prefix,
    suffix: f.suffix,
    digits: Number(f.digits),
    startNo: Number(f.startNo),
    endNo: optionalNumber(f.endNo),
    increment: Number(f.increment),
    warnAt: optionalNumber(f.warnAt),
    reset: f.reset,
  };
}

export interface SeriesFormState {
  description: string;
  mode: SeriesMode;
  manualAllowed: boolean;
  defaultNumbers: boolean;
  dateOrder: boolean;
  blockSize: string;
  isActive: boolean;
}

export function seriesFormFrom(s: { description: string; mode: SeriesMode; manualAllowed: boolean; defaultNumbers: boolean; dateOrder: boolean; blockSize: number; isActive: boolean }): SeriesFormState {
  return { ...s, blockSize: String(s.blockSize) };
}

/** A series' settings as they are sent: gap-free series may follow document dates, the others use blocks. */
export function seriesPatch(form: SeriesFormState) {
  const size = Number(form.blockSize);
  return {
    description: form.description,
    mode: form.mode,
    manualAllowed: form.manualAllowed,
    defaultNumbers: form.defaultNumbers,
    dateOrder: form.mode === 'gap_free' ? form.dateOrder : false,
    blockSize: Number.isFinite(size) && size > 0 ? size : 50,
    isActive: form.isActive,
  };
}

/** Switching the mode: allowing gaps cannot keep "follow document dates". */
export const withMode = (form: SeriesFormState, mode: SeriesMode): SeriesFormState => ({ ...form, mode, dateOrder: mode === 'gap_free' ? form.dateOrder : false });

export const SETTING_TOGGLES = [
  ['defaultNumbers', 'Number documents automatically'],
  ['manualAllowed', 'Allow typed-in numbers'],
  ['isActive', 'Series is active'],
] as const;

/** Adds a template token such as {YY} to the end of a prefix or suffix. */
export const withToken = (value: string, token: string): string => `${value}{${token}}`;

/** What a binding change says it will do, for the confirmation sentence. */
export function bindingQuestion(change: { kindLabel: string; branchLabel: string; seriesCode: string | null }): string {
  const what = change.kindLabel.toLowerCase();
  return change.seriesCode === null
    ? `Stop using a specific series for ${what} (${change.branchLabel})?`
    : `Number ${what} (${change.branchLabel}) with ${change.seriesCode}?`;
}

export interface BindingRow {
  documentKind: string;
  branchId: string | null;
  branchLabel: string | null;
  seriesId: string;
  seriesLabel: string;
}

/** The series a kind of document uses when no branch has its own. */
export const defaultBinding = (bindings: readonly BindingRow[], kind: string): BindingRow | undefined => bindings.find((b) => b.documentKind === kind && b.branchId === null);

/** The branches that number a kind of document with a series of their own. */
export const overridesOf = (bindings: readonly BindingRow[], kind: string): BindingRow[] => bindings.filter((b) => b.documentKind === kind && b.branchId !== null);

/** The code part of a series' "CODE — description" label. */
export const seriesCodeOf = (label: string): string => label.split(' — ')[0] ?? label;
