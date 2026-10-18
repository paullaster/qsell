import { AmountError, convert, isZero, parseAmount, type Scaled } from './amount';
import type { Issue, JournalLineInput, PostingRequest } from './types';
import { trimToNull } from '@/lib/values';

/** What the validator needs to know about an account, loaded once per posting. */
export interface AccountFacts {
  id: string;
  no: string;
  name: string;
  type: string;
  blocked: boolean;
  directPosting: boolean;
  /** engine_only accounts (control accounts) refuse manual journals. */
  postingSource: 'manual' | 'engine_only';
  /** "any" or a single ISO currency the account is restricted to. */
  currencyPolicy: string;
  dimensionRule: 'none' | 'required' | 'forbidden';
  /** Already posted to, so the "used" mark need not be written again. */
  used?: boolean;
}

export interface PeriodFacts {
  id: string;
  status: 'open' | 'soft_closed' | 'closed' | 'locked';
  startsOn: string;
  endsOn: string;
}

export interface PostingPolicy {
  baseCurrency: string;
  period: PeriodFacts | null;
  /** The user's own posting window (inclusive ISO dates), null = unrestricted. */
  window: { from: string | null; to: string | null };
  canPostSoftClosed: boolean;
  canPostControlAccounts: boolean;
  accounts: Map<string, AccountFacts>;
}

export interface PreparedLine {
  index: number;
  accountId: string;
  debit: Scaled;
  credit: Scaled;
  baseDebit: Scaled;
  baseCredit: Scaled;
  description: string | null;
  dimensionSetId: string | null;
  currency: string;
  sourceLedger: string | null;
  sourceEntryId: string | null;
}

export interface PreparedPosting {
  lines: PreparedLine[];
  totalDebit: Scaled;
  totalCredit: Scaled;
  baseTotalDebit: Scaled;
  baseTotalCredit: Scaled;
}

export type ValidationResult =
  | { ok: true; posting: PreparedPosting; issues: [] }
  | { ok: false; issues: Issue[] };

const DATE = /^\d{4}-\d{2}-\d{2}$/;


/** The date rules alone (period status, the user's posting window), for callers with no lines yet. */
export function checkPostingDate(
  postingDate: string,
  policy: Pick<PostingPolicy, 'period' | 'window' | 'canPostSoftClosed'>,
): Issue[] {
  const issues: Issue[] = [];
  if (!DATE.test(postingDate)) return issues;
  const period = policy.period;
  if (period === null) {
    issues.push({ code: 'NO_PERIOD', message: `No accounting period covers ${postingDate}.` });
  } else if (period.status === 'locked' || period.status === 'closed') {
    issues.push({
      code: 'PERIOD_CLOSED',
      message: `The period ${period.startsOn} to ${period.endsOn} is ${period.status}.`,
    });
  } else if (period.status === 'soft_closed' && !policy.canPostSoftClosed) {
    issues.push({
      code: 'PERIOD_SOFT_CLOSED',
      message: `The period ${period.startsOn} to ${period.endsOn} is soft-closed; you need permission to post to it.`,
    });
  }
  const { from, to } = policy.window;
  if ((from !== null && postingDate < from) || (to !== null && postingDate > to)) {
    issues.push({ code: 'OUTSIDE_POSTING_WINDOW', message: 'The posting date is outside the dates you may post to.' });
  }
  return issues;
}

/**
 * The single rule-set a journal must pass before anything is written. Pure: it reads only what
 * it is given, so every refusal can be reproduced in a test. All problems are reported together.
 */
export function validatePosting(req: PostingRequest, policy: PostingPolicy): ValidationResult {
  const issues: Issue[] = [];
  const fail = (code: string, message: string, line?: number) =>
    issues.push({ code, message, ...(line !== undefined ? { line } : {}) });

  if (!DATE.test(req.postingDate)) fail('POSTING_DATE_INVALID', 'The posting date is not a date.');
  if (req.lines.length < 2) fail('TOO_FEW_LINES', 'A journal needs at least two lines.');
  if (req.idempotencyKey.trim() === '') fail('NO_IDEMPOTENCY_KEY', 'A posting key is required.');

  // Period and window.
  for (const issue of checkPostingDate(req.postingDate, policy)) issues.push(issue);

  const sameRate = req.currency === policy.baseCurrency;
  let rateOk = true;
  // A rate has up to 8 decimals (a wallet's average rate does); amounts have 4.
  if (!sameRate && !/^\d{1,15}(\.\d{1,8})?$/.test(req.rate)) {
    rateOk = false;
    fail('RATE_INVALID', `The exchange rate "${req.rate}" is not a number.`);
  } else if (!sameRate && !/[1-9]/.test(req.rate)) {
    rateOk = false;
    fail('RATE_MISSING', `No exchange rate for ${req.currency}.`);
  }
  const rate = sameRate ? '1' : req.rate;

  const lines: PreparedLine[] = [];
  let totalDebit = 0n;
  let totalCredit = 0n;
  let baseDebit = 0n;
  let baseCredit = 0n;

  req.lines.forEach((l: JournalLineInput, i: number) => {
    const n = i + 1;
    let debit: Scaled;
    let credit: Scaled;
    try {
      debit = parseAmount(l.debit === '' ? '0' : l.debit);
      credit = parseAmount(l.credit === '' ? '0' : l.credit);
    } catch (e) {
      fail('AMOUNT_INVALID', e instanceof AmountError ? e.message : 'Invalid amount.', n);
      return;
    }
    if (debit < 0n || credit < 0n) {
      fail('AMOUNT_NEGATIVE', 'Debits and credits are entered as positive amounts.', n);
      return;
    }
    if (isZero(debit) === isZero(credit)) {
      fail(
        'ONE_SIDE_ONLY',
        isZero(debit) ? 'A line needs a debit or a credit.' : 'A line cannot have both a debit and a credit.',
        n,
      );
      return;
    }
    const currency = l.currency ?? req.currency;
    if (currency !== req.currency) {
      fail('MIXED_CURRENCY', 'All lines of one journal share its currency.', n);
      return;
    }

    const account = policy.accounts.get(l.accountId);
    if (account === undefined) {
      fail('ACCOUNT_UNKNOWN', 'This account does not exist.', n);
    } else {
      if (account.type !== 'posting') {
        fail('ACCOUNT_NOT_POSTING', `${account.no} ${account.name} is not a posting account.`, n);
      }
      if (account.blocked) fail('ACCOUNT_BLOCKED', `${account.no} ${account.name} is blocked.`, n);
      if (req.postedBy === 'user') {
        if (!account.directPosting) {
          fail('NO_DIRECT_POSTING', `${account.no} ${account.name} does not allow direct posting.`, n);
        }
        if (account.postingSource === 'engine_only' && !policy.canPostControlAccounts) {
          fail(
            'CONTROL_ACCOUNT',
            `${account.no} ${account.name} is a control account: only its sub-ledger can post to it.`,
            n,
          );
        }
      }
      if (account.currencyPolicy !== 'any' && account.currencyPolicy !== currency) {
        fail('ACCOUNT_CURRENCY', `${account.no} only takes ${account.currencyPolicy}.`, n);
      }
      const hasDimensions = l.dimensionSetId !== undefined && l.dimensionSetId !== null;
      if (account.dimensionRule === 'required' && !hasDimensions) {
        fail('DIMENSION_REQUIRED', `${account.no} ${account.name} needs dimensions on every line.`, n);
      }
      if (account.dimensionRule === 'forbidden' && hasDimensions) {
        fail('DIMENSION_FORBIDDEN', `${account.no} ${account.name} does not take dimensions.`, n);
      }
    }

    const bd = rateOk ? convert(debit, rate) : 0n;
    const bc = rateOk ? convert(credit, rate) : 0n;
    totalDebit += debit;
    totalCredit += credit;
    baseDebit += bd;
    baseCredit += bc;
    lines.push({
      index: n,
      accountId: l.accountId,
      debit,
      credit,
      baseDebit: bd,
      baseCredit: bc,
      description: trimToNull(l.description),
      dimensionSetId: l.dimensionSetId ?? null,
      currency,
      sourceLedger: l.sourceLedger ?? null,
      sourceEntryId: l.sourceEntryId ?? null,
    });
  });

  if (totalDebit !== totalCredit) {
    fail('NOT_BALANCED', 'Debits and credits are not equal in the journal currency.');
  } else if (rateOk && baseDebit !== baseCredit) {
    // Conversion rounding can leave a difference of a few units of the fourth decimal; the
    // largest line absorbs it, as Business Central does with its rounding entry.
    const diff = baseDebit - baseCredit;
    const limit = BigInt(Math.max(lines.length, 1));
    if ((diff < 0n ? -diff : diff) > limit) {
      fail('NOT_BALANCED_BASE', 'Debits and credits are not equal in the base currency.');
    } else {
      absorbRounding(lines, diff);
      baseDebit = lines.reduce((a, l) => a + l.baseDebit, 0n);
      baseCredit = lines.reduce((a, l) => a + l.baseCredit, 0n);
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    issues: [],
    posting: {
      lines,
      totalDebit,
      totalCredit,
      baseTotalDebit: baseDebit,
      baseTotalCredit: baseCredit,
    },
  };
}

/** Moves a conversion-rounding difference onto the largest line on the heavier side. */
function absorbRounding(lines: PreparedLine[], diff: bigint): void {
  // diff > 0: base debits exceed base credits, so reduce the largest debit (or raise a credit).
  if (diff > 0n) {
    const target = [...lines].filter((l) => l.baseDebit > 0n).sort((a, b) => Number(b.baseDebit - a.baseDebit))[0];
    if (target) target.baseDebit -= diff;
  } else {
    const target = [...lines].filter((l) => l.baseCredit > 0n).sort((a, b) => Number(b.baseCredit - a.baseCredit))[0];
    if (target) target.baseCredit += diff;
  }
}

/** The mirror of a posting, for reversals: every line on the opposite side. */
export function reverseLines(lines: JournalLineInput[]): JournalLineInput[] {
  return lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit }));
}
