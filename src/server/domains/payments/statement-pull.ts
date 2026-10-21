import { isRecord, readText } from '@/lib/values';

/**
 * Pulling an account's statement from a bank through its API. The platform drivers turn what the bank answers into plain lines
 * (a date, words, a signed amount in cents, the running balance); the finance side keeps them exactly like an imported file.
 * Pure: no network, no database.
 */

export interface StatementPullRequest {
  /** The account's number at the bank. */
  accountNumber: string;
  countryCode: string;
  /** YYYY-MM-DD, inclusive. */
  fromDate: string;
  toDate: string;
}

export interface PulledLine {
  /** YYYY-MM-DD, the day the bank posted it. */
  date: string;
  description: string;
  reference: string | null;
  counterparty: string | null;
  /** Positive = money in. */
  amountCents: number;
  balanceCents: number | null;
  /** The bank's own position of the line in the answer, used only to order lines of one day. */
  order: number;
}

export type StatementPullResult =
  | { ok: true; lines: PulledLine[]; pages: number; truncated: boolean }
  | { ok: false; error: string; retryable: boolean };

/** Most pages one pull may read, so a bank that keeps answering cannot keep us reading. */
export const MAX_PULL_PAGES = 40;
/** Most days one pull may cover. */
export const MAX_PULL_DAYS = 92;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The range checked: real days, from not after to, not in the future, and no longer than the limit. */
export function checkPullRange(fromDate: string, toDate: string, today: string): string | null {
  if (!DAY.test(fromDate) || !DAY.test(toDate)) return 'Dates must be written YYYY-MM-DD.';
  if (
    Number.isNaN(Date.parse(`${fromDate}T00:00:00Z`)) ||
    Number.isNaN(Date.parse(`${toDate}T00:00:00Z`))
  )
    return 'One of the dates is not a real day.';
  if (fromDate > toDate) return 'The first day must not be after the last day.';
  if (toDate > today) return 'The last day cannot be in the future.';
  const days =
    (Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000 + 1;
  if (days > MAX_PULL_DAYS)
    return `A pull can cover at most ${String(MAX_PULL_DAYS)} days. Pull the rest in another go.`;
  return null;
}

/** Cents from a number or text the bank sent ("1,250.50", 1250.5); null when it is not an amount with at most 2 decimals worth keeping. */
export function centsFrom(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) : null;
  if (typeof value !== 'string') return null;
  const t = value.trim().replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

const dayOf = (value: unknown): string | null => {
  const t = typeof value === 'string' ? value.trim() : '';
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(t);
  return m === null ? null : m[1];
};

// ── Jenga ────────────────────────────────────────────────────────────────────

/** The text Jenga's full statement call is signed over: account number, country code and the last day, joined with nothing between. */
export const jengaFullStatementPlain = (r: StatementPullRequest): string =>
  `${r.accountNumber}${r.countryCode}${r.toDate}`;

/** One transaction of Jenga's answer, kept as it came so the next page can start after it. */
export type JengaTransaction = Record<string, unknown>;

export interface JengaPage {
  transactions: JengaTransaction[];
  /** Why the page is not usable, in words; null when it is. */
  problem: string | null;
}

/** Reads one answer of Jenga's full statement call. A refusal, a missing list or an unreadable transaction is a problem, never silently dropped. */
export function readJengaPage(json: unknown): JengaPage {
  if (!isRecord(json))
    return { transactions: [], problem: 'Jenga did not answer with a statement.' };
  if (json.status === false)
    return { transactions: [], problem: readText(json.message, 'Jenga refused the request.') };
  const data = isRecord(json.data) ? json.data : json;
  const list = data.transactions;
  if (!Array.isArray(list))
    return { transactions: [], problem: "Jenga's answer had no list of transactions." };
  const out: JengaTransaction[] = [];
  for (const [i, t] of list.entries()) {
    if (!isRecord(t))
      return {
        transactions: [],
        problem: `Transaction ${String(i + 1)} in Jenga\'s answer is not readable.`,
      };
    out.push(t);
  }
  return { transactions: out, problem: null };
}

/** The fields Jenga wants echoed back to continue after a transaction ("the page after this one"). */
export function jengaCursor(last: JengaTransaction): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ['reference', 'serial', 'postedDateTime', 'date', 'runningBalance'] as const) {
    if (last[key] !== undefined) out[key] = last[key];
  }
  return out;
}

/** Jenga's transactions as plain lines: a Credit is money in, a Debit money out. The day is the day it was posted. */
export function jengaLines(transactions: readonly JengaTransaction[]): {
  lines: PulledLine[];
  problem: string | null;
} {
  const lines: PulledLine[] = [];
  for (const [i, t] of transactions.entries()) {
    const n = i + 1;
    const date = dayOf(t.postedDateTime) ?? dayOf(t.date);
    const cents = centsFrom(t.amount);
    const type = readText(t.type, '').toLowerCase();
    if (date === null)
      return { lines: [], problem: `Transaction ${String(n)}: the date could not be read.` };
    if (cents === null || cents === 0)
      return { lines: [], problem: `Transaction ${String(n)}: the amount could not be read.` };
    if (type !== 'credit' && type !== 'debit')
      return {
        lines: [],
        problem: `Transaction ${String(n)}: it is neither a credit nor a debit.`,
      };
    const running = isRecord(t.runningBalance) ? centsFrom(t.runningBalance.amount) : null;
    const reference = readText(t.reference, '');
    lines.push({
      date,
      description: readText(t.description, '').slice(0, 1000),
      reference: reference === '' ? null : reference.slice(0, 200),
      counterparty: null,
      amountCents: type === 'debit' ? -Math.abs(cents) : Math.abs(cents),
      balanceCents: running,
      order: i,
    });
  }
  return { lines, problem: null };
}

// ── a bank whose statement call is described in the provider's settings ────────

export interface StatementMap {
  /** Where the list of transactions is in the answer, as dotted keys ("data.transactions"). */
  list: string;
  date: string;
  description: string;
  reference?: string;
  counterparty?: string;
  balance?: string;
  /** One signed amount... */
  amount?: string;
  /** ...or an amount with its direction in another field. */
  amountAbs?: string;
  direction?: string;
  /** Words of the direction field that mean money in ("Credit", "CR"). Everything else is money out. */
  creditWords?: string[];
}

const pick = (value: unknown, path: string): unknown => {
  let cur: unknown = value;
  for (const key of path.split('.')) {
    if (!isRecord(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
};

/** The mapping a person saved in the provider settings, checked: the keys it needs, as text. Null when it is not usable. */
export function readStatementMap(raw: unknown): StatementMap | null {
  if (!isRecord(raw)) return null;
  const text = (k: string): string | undefined =>
    typeof raw[k] === 'string' && raw[k].trim() !== '' ? raw[k].trim() : undefined;
  const list = text('list');
  const date = text('date');
  const description = text('description');
  const amount = text('amount');
  const amountAbs = text('amountAbs');
  const direction = text('direction');
  if (list === undefined || date === undefined || description === undefined) return null;
  if (amount === undefined && (amountAbs === undefined || direction === undefined)) return null;
  const creditWords = Array.isArray(raw.creditWords)
    ? raw.creditWords.filter((w): w is string => typeof w === 'string')
    : undefined;
  return {
    list,
    date,
    description,
    reference: text('reference'),
    counterparty: text('counterparty'),
    balance: text('balance'),
    amount,
    amountAbs,
    direction,
    creditWords,
  };
}

/** Lines read from any JSON answer, following the saved mapping. */
export function mappedLines(
  json: unknown,
  map: StatementMap,
): { lines: PulledLine[]; problem: string | null } {
  const list = pick(json, map.list);
  if (!Array.isArray(list))
    return { lines: [], problem: `The answer has no list at "${map.list}".` };
  const credit = new Set((map.creditWords ?? ['credit', 'cr', 'c']).map((w) => w.toLowerCase()));
  const lines: PulledLine[] = [];
  for (const [i, item] of list.entries()) {
    const n = i + 1;
    const date = dayOf(pick(item, map.date));
    if (date === null)
      return {
        lines: [],
        problem: `Transaction ${String(n)}: the date at "${map.date}" could not be read.`,
      };
    let cents: number | null;
    if (map.amount !== undefined) cents = centsFrom(pick(item, map.amount));
    else {
      const abs = centsFrom(pick(item, map.amountAbs ?? ''));
      const way = readText(pick(item, map.direction ?? ''), '').toLowerCase();
      cents = abs === null || way === '' ? null : credit.has(way) ? Math.abs(abs) : -Math.abs(abs);
    }
    if (cents === null || cents === 0)
      return { lines: [], problem: `Transaction ${String(n)}: the amount could not be read.` };
    const reference = map.reference === undefined ? '' : readText(pick(item, map.reference), '');
    const counterparty =
      map.counterparty === undefined ? '' : readText(pick(item, map.counterparty), '');
    lines.push({
      date,
      description: readText(pick(item, map.description), '').slice(0, 1000),
      reference: reference === '' ? null : reference.slice(0, 200),
      counterparty: counterparty === '' ? null : counterparty.slice(0, 200),
      amountCents: cents,
      balanceCents: map.balance === undefined ? null : centsFrom(pick(item, map.balance)),
      order: i,
    });
  }
  return { lines, problem: null };
}

/** Puts a template's {account}, {from}, {to} and {country} in place, in text only (never into a path of the platform's own making). */
export function fillTemplate(template: string, r: StatementPullRequest): string {
  return template
    .replaceAll('{account}', r.accountNumber)
    .replaceAll('{from}', r.fromDate)
    .replaceAll('{to}', r.toDate)
    .replaceAll('{country}', r.countryCode);
}
