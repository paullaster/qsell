/**
 * What the screens for bank payment files ask for and say. Pure: choosing refunds, totals and wording.
 */
export interface Candidate {
  id: string;
  amount: string;
  approvedBy: string | null;
}

export const MAX_PICK = 500;

const toCents = (amount: string): number => Math.round(Number(amount) * 100);
const fromCents = (cents: number): string => (cents / 100).toFixed(2);

/** The total of the chosen refunds, as text with two places. */
export function pickedTotal(rows: readonly Candidate[], picked: ReadonlySet<string>): string {
  return fromCents(rows.filter((r) => picked.has(r.id)).reduce((n, r) => n + toCents(r.amount), 0));
}

/** The ones the person asking approved themselves: the server will refuse them, so say so before they try. */
export function ownApprovals(rows: readonly Candidate[], picked: ReadonlySet<string>, me: string | null): string[] {
  return me === null ? [] : rows.filter((r) => picked.has(r.id) && r.approvedBy === me).map((r) => r.id);
}

export function fileProblem(input: { methodId: string | null; formatId: string | null; picked: number; executionDate: string; today: string }): string | null {
  if (input.picked === 0) return 'Tick at least one refund to put in the file.';
  if (input.picked > MAX_PICK) return `A file holds at most ${String(MAX_PICK)} refunds.`;
  if (input.methodId === null) return 'Choose the bank the money will be paid from.';
  if (input.formatId === null) return 'Choose a file format.';
  if (input.executionDate < input.today) return 'The bank cannot pay on a day that has passed.';
  return null;
}

/** Ticks every row in the list, or clears them all. */
export const toggleAll = (rows: readonly Candidate[], picked: ReadonlySet<string>): Set<string> => (picked.size === rows.length ? new Set() : new Set(rows.slice(0, MAX_PICK).map((r) => r.id)));

export const toggleOne = (picked: ReadonlySet<string>, id: string): Set<string> => {
  const next = new Set(picked);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
};

export function confirmProblem(input: { reference: string; evidence: number }): string | null {
  if (input.reference.trim() === '') return 'Enter the reference the bank gave for the file.';
  if (input.evidence === 0) return 'Attach the bank\'s confirmation first.';
  return null;
}

/** The colour of a line in a payment file: waiting, paid, or let go when the file was cancelled. */
export function itemTone(state: string): 'green' | 'gray' | 'sky' {
  if (state === 'paid') return 'green';
  return state === 'released' ? 'gray' : 'sky';
}

export const itemWords = (state: string): string => (state === 'in_file' ? 'in the file' : state);
