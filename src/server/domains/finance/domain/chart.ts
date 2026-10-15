import type { AccountCategory, AccountType, NormalBalance } from './types';

import { has } from '@/lib/has';

export interface AccountDraft {
  no: string;
  name: string;
  type: AccountType;
  category: AccountCategory | null;
  subcategory?: string | null;
  normalBalance: NormalBalance;
  directPosting: boolean;
  /** "engine_only" marks control accounts that only a sub-ledger may post to. */
  postingSource: 'manual' | 'engine_only';
  /** For total/end_total accounts: "1000..1999|2100". */
  totaling?: string | null;
  indent: number;
}

export interface ChartIssue {
  no: string | null;
  message: string;
}

/** Numeric-aware comparison: "900" < "1000", while "A10" and "A9" still order sensibly. */
export function compareAccountNo(a: string, b: string): number {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb) {
    const d = BigInt(a) - BigInt(b);
    return d < 0n ? -1 : d > 0n ? 1 : 0;
  }
  return a.localeCompare(b, 'en', { numeric: true });
}

/** Does `no` fall inside a totaling expression like "1000..1999|2100|2200..2299"? */
export function matchesTotaling(no: string, totaling: string): boolean {
  return totaling
    .split('|')
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .some((part) => {
      const [from, to] = part.split('..');
      if (to === undefined) return from === no;
      return compareAccountNo(no, from ?? '') >= 0 && compareAccountNo(no, to) <= 0;
    });
}

export function isValidTotaling(totaling: string): boolean {
  return /^[A-Za-z0-9._-]+(\.\.[A-Za-z0-9._-]+)?(\|[A-Za-z0-9._-]+(\.\.[A-Za-z0-9._-]+)?)*$/.test(
    totaling.trim(),
  );
}

/** Checks a whole chart (a template, or an import) before anything is written. */
export function validateChart(accounts: AccountDraft[]): ChartIssue[] {
  const issues: ChartIssue[] = [];
  const seen = new Set<string>();
  let depth = 0;
  for (const a of accounts) {
    if (a.no.trim() === '') issues.push({ no: null, message: 'An account has no number.' });
    if (seen.has(a.no)) issues.push({ no: a.no, message: `Account ${a.no} appears twice.` });
    seen.add(a.no);
    if (a.name.trim() === '') issues.push({ no: a.no, message: `Account ${a.no} has no name.` });
    if ((a.type === 'total' || a.type === 'end_total') && (a.totaling ?? '') === '') {
      issues.push({ no: a.no, message: `Total account ${a.no} needs a range to add up.` });
    }
    if (has(a.totaling) && !isValidTotaling(a.totaling)) {
      issues.push({ no: a.no, message: `Account ${a.no}: "${a.totaling}" is not a valid range.` });
    }
    if (a.type === 'posting' && a.category === null) {
      issues.push({ no: a.no, message: `Posting account ${a.no} needs a category.` });
    }
    if (a.type !== 'posting' && a.directPosting) {
      issues.push({ no: a.no, message: `${a.no} is not a posting account, so it cannot allow posting.` });
    }
    if (a.type === 'begin_total') depth += 1;
    if (a.type === 'end_total') {
      depth -= 1;
      if (depth < 0) issues.push({ no: a.no, message: `End-total ${a.no} has no matching begin-total.` });
    }
  }
  if (depth > 0) issues.push({ no: null, message: 'A begin-total has no matching end-total.' });
  return issues;
}

/** Balance of a total account: the sum of the posting accounts its range covers. */
export function totalBalance(
  totaling: string,
  balances: { no: string; type: AccountType; net: bigint }[],
): bigint {
  return balances
    .filter((b) => b.type === 'posting' && matchesTotaling(b.no, totaling))
    .reduce((sum, b) => sum + b.net, 0n);
}
