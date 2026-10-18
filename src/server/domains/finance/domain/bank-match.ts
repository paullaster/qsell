/**
 * The rules that decide how a line on a bank statement is matched to something we recorded: how closely the amount must agree,
 * how far apart the dates may be, and whether the bank quoting our reference, the payer's phone number or the payer's name is
 * enough. Pure: rules and words in, a verdict out. Whatever the rules say, a line is closed by itself only when the amount agrees
 * exactly and the evidence points at one entry; everything else is a suggestion for a person to confirm.
 */
export type Certainty = 'off' | 'propose' | 'auto';

export interface MatchRules {
  /** The line quotes our own reference (a receipt number, the payer's reference, a payout reference). */
  reference: Certainty;
  /** References shorter than this are too common to trust. */
  minRefLength: number;
  /** How far, in cents, the line's amount may differ from an entry's for it to be suggested. 0 = exactly. */
  amountToleranceCents: number;
  dateWindowDays: number;
  /** The line mentions a phone number that is the customer's. */
  phone: Certainty;
  /** The payer's name on the line resembles the customer's name (only ever a suggestion). */
  name: Exclude<Certainty, 'auto'>;
  /** 0.5 to 1: how alike two names must be. */
  nameMinScore: number;
  maxProposals: number;
}

export const DEFAULT_RULES: MatchRules = {
  reference: 'auto',
  minRefLength: 5,
  amountToleranceCents: 0,
  dateWindowDays: 3,
  phone: 'off',
  name: 'off',
  nameMinScore: 0.6,
  maxProposals: 5,
};

const CERTAINTY: readonly string[] = ['off', 'propose', 'auto'];

/** The rules as sent by a person: checked, with a message for the first thing wrong. */
export function checkRules(raw: Record<string, unknown>): { ok: true; rules: MatchRules } | { ok: false; error: string } {
  const choice = (k: string, allowed: readonly string[]): string | null => {
    const v = raw[k];
    return typeof v === 'string' && allowed.includes(v) ? v : null;
  };
  const int = (k: string, min: number, max: number): number | null => {
    const v = raw[k];
    return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null;
  };
  const reference = choice('reference', CERTAINTY);
  const phone = choice('phone', CERTAINTY);
  const name = choice('name', ['off', 'propose']);
  const minRefLength = int('minRefLength', 3, 20);
  const amountToleranceCents = int('amountToleranceCents', 0, 100_000);
  const dateWindowDays = int('dateWindowDays', 0, 30);
  const maxProposals = int('maxProposals', 1, 10);
  const score = typeof raw.nameMinScore === 'number' && raw.nameMinScore >= 0.5 && raw.nameMinScore <= 1 ? raw.nameMinScore : null;
  if (reference === null || phone === null || name === null) return { ok: false, error: 'Choose what each kind of evidence is worth: ignore it, suggest only, or match by itself.' };
  if (minRefLength === null) return { ok: false, error: 'A reference must be at least 3 and at most 20 characters to be trusted.' };
  if (amountToleranceCents === null) return { ok: false, error: 'The amount difference allowed must be between 0 and 1,000.00.' };
  if (dateWindowDays === null) return { ok: false, error: 'The dates may be 0 to 30 days apart.' };
  if (maxProposals === null) return { ok: false, error: 'Suggest between 1 and 10 entries per line.' };
  if (score === null) return { ok: false, error: 'Names must be at least half alike (0.5) and at most identical (1).' };
  return { ok: true, rules: { reference: reference as Certainty, minRefLength, amountToleranceCents, dateWindowDays, phone: phone as Certainty, name: name as 'off' | 'propose', nameMinScore: score, maxProposals } };
}

/** The last nine digits of every phone-like number in the text: enough to tell numbers apart whatever way they were written. */
export function phoneKeysIn(text: string): string[] {
  const keys = new Set<string>();
  for (const m of text.matchAll(/(?:\+?\d[\d\s().-]{7,}\d)/g)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 9 && digits.length <= 15) keys.add(digits.slice(-9));
  }
  // M-Pesa often masks the middle of a number (2547****123); a masked number is not evidence of anyone.
  return [...keys];
}

export const phoneKeyOf = (phone: string | null | undefined): string | null => {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.length >= 9 ? digits.slice(-9) : null;
};

const STOP = new Set(['mr', 'mrs', 'ms', 'dr', 'ltd', 'limited', 'co', 'company', 'and', 'the', 'of', 'inc', 'plc', 'llc', 'enterprises', 'enterprise', 'sons']);

/** The words of a name worth comparing: letters only, lower case, titles and company endings dropped. */
export function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP.has(t));
}

/** How alike two names are, 0 to 1: the share of words they have in common, tolerating one slip in a longer word. */
export function nameScore(a: string, b: string): number {
  const x = nameTokens(a);
  const y = nameTokens(b);
  if (x.length === 0 || y.length === 0) return 0;
  const used = new Set<number>();
  let shared = 0;
  for (const t of x) {
    const at = y.findIndex((u, i) => !used.has(i) && (u === t || (t.length >= 5 && u.length >= 5 && oneSlip(t, u))));
    if (at >= 0) {
      used.add(at);
      shared += 1;
    }
  }
  return (2 * shared) / (x.length + y.length);
}

/** True when two words differ by one letter changed, added or dropped. */
function oneSlip(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let slips = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    slips += 1;
    if (slips > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return slips + (a.length - i) + (b.length - j) <= 1;
}
