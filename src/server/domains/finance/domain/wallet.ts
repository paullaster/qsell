import { fromCents } from './receivables';

import { has } from '@/lib/values';

/** The "refund or wallet" rules in force for a customer, as plain data. */
export interface CreditPolicy {
  walletEnabled: boolean;
  allowDeposits: boolean;
  overpaymentDefault: 'wallet' | 'hold' | 'ask';
  autoApply: 'never' | 'oldest_first';
  /** Where the part of a credit note the invoice cannot absorb goes. */
  creditNoteExcess: 'wallet' | 'ask';
  /** Can money be paid back out to customers? */
  refundsEnabled: boolean;
  /** May a wallet be paid out as a refund? */
  walletCashOut: boolean;
  maxCents: number | null;
  /** A balance nobody has touched for this many days lapses (null = never). */
  expiryDays: number | null;
  /** How many days before it lapses it is shown as about to. */
  expiryNoticeDays: number;
  /** What customers see it called: Wallet, Account credit, Store credit. */
  label: string;
}

/** With no policy at all nothing changes from before: no wallet, excess stays as unapplied credit. */
export const DEFAULT_POLICY: CreditPolicy = {
  walletEnabled: false,
  allowDeposits: true,
  overpaymentDefault: 'ask',
  autoApply: 'never',
  creditNoteExcess: 'ask',
  refundsEnabled: true,
  walletCashOut: false,
  maxCents: null,
  expiryDays: null,
  expiryNoticeDays: 30,
  label: 'Wallet',
};

export interface PolicyRow extends CreditPolicy {
  groupCode: string | null;
  effectiveFrom: string;
}

/**
 * The row in force on `date`: the newest one for the customer's posting group if there is one,
 * otherwise the newest company-wide row. The label always comes from the company-wide row so a
 * customer is not shown two names for the same thing.
 */
export function pickPolicy(rows: PolicyRow[], groupCode: string | null, date: string): CreditPolicy & { source: 'group' | 'company' | 'default' } {
  const inForce = (r: PolicyRow) => r.effectiveFrom <= date;
  const newest = (list: PolicyRow[]) => [...list].filter(inForce).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
  const company = newest(rows.filter((r) => r.groupCode === null));
  const group = has(groupCode) ? newest(rows.filter((r) => r.groupCode === groupCode)) : undefined;
  const chosen = group ?? company;
  if (!chosen) return { ...DEFAULT_POLICY, source: 'default' };
  return { ...chosen, label: company?.label ?? chosen.label, source: group ? 'group' : 'company' };
}

export interface WalletIssue {
  code: 'WALLET_OFF' | 'DEPOSITS_OFF' | 'WALLET_FROZEN' | 'WALLET_INSUFFICIENT' | 'WALLET_LIMIT' | 'AMOUNT_INVALID';
  message: string;
}

/** Putting money in. `deposit` is an advance; an overpayment is allowed whenever the wallet is. */
export function checkCredit(
  policy: CreditPolicy,
  wallet: { status: 'active' | 'frozen'; balanceCents: number },
  cents: number,
  kind: 'deposit' | 'overpayment',
): WalletIssue | null {
  const name = policy.label;
  if (!(cents > 0)) return { code: 'AMOUNT_INVALID', message: 'The amount must be more than zero.' };
  if (!policy.walletEnabled) return { code: 'WALLET_OFF', message: `The ${name.toLowerCase()} is not switched on for this customer.` };
  if (kind === 'deposit' && !policy.allowDeposits) return { code: 'DEPOSITS_OFF', message: `Advance deposits into the ${name.toLowerCase()} are not allowed.` };
  if (wallet.status === 'frozen') return { code: 'WALLET_FROZEN', message: `This customer's ${name.toLowerCase()} is frozen.` };
  if (policy.maxCents !== null && wallet.balanceCents + cents > policy.maxCents) {
    return { code: 'WALLET_LIMIT', message: `The ${name.toLowerCase()} could hold at most ${fromCents(policy.maxCents)}; this would make it ${fromCents(wallet.balanceCents + cents)}.` };
  }
  return null;
}

/** Taking money out. Never more than is there, never from a frozen wallet. */
export function checkDebit(
  policy: CreditPolicy,
  wallet: { status: 'active' | 'frozen'; balanceCents: number },
  cents: number,
): WalletIssue | null {
  const name = policy.label.toLowerCase();
  if (!(cents > 0)) return { code: 'AMOUNT_INVALID', message: 'The amount must be more than zero.' };
  if (wallet.status === 'frozen') return { code: 'WALLET_FROZEN', message: `This customer's ${name} is frozen.` };
  if (cents > wallet.balanceCents) {
    return { code: 'WALLET_INSUFFICIENT', message: `Only ${fromCents(wallet.balanceCents)} is in the ${name}.` };
  }
  return null;
}

/** How much of an invoice the wallet should pay on its own: the lesser of the two. */
export function autoApplyAmount(policy: CreditPolicy, walletCents: number, invoiceOpenCents: number): number {
  if (!policy.walletEnabled || policy.autoApply === 'never') return 0;
  return Math.max(0, Math.min(walletCents, invoiceOpenCents));
}

const DAY_MS = 86_400_000;

export type ExpiryState = 'never' | 'ok' | 'soon' | 'lapsed';

/** The day a balance last touched on `lastTouched` lapses, as a date; null when balances do not lapse. */
export function lapseDate(lastTouched: Date, expiryDays: number | null): string | null {
  if (expiryDays === null) return null;
  return new Date(lastTouched.getTime() + expiryDays * DAY_MS).toISOString().slice(0, 10);
}

/** Whether a balance has lapsed, is about to, or is safe; `now` is passed in so the answer is repeatable. */
export function expiryState(lastTouched: Date, now: Date, policy: Pick<CreditPolicy, 'expiryDays' | 'expiryNoticeDays'>): ExpiryState {
  if (policy.expiryDays === null) return 'never';
  const idleDays = (now.getTime() - lastTouched.getTime()) / DAY_MS;
  if (idleDays >= policy.expiryDays) return 'lapsed';
  return idleDays >= policy.expiryDays - policy.expiryNoticeDays ? 'soon' : 'ok';
}

/** Checks the expiry settings as typed: whole days, a notice shorter than the expiry. */
export function checkExpiry(expiryDays: number | null, noticeDays: number): string | null {
  if (expiryDays !== null && (!Number.isInteger(expiryDays) || expiryDays < 30 || expiryDays > 3650)) return 'A balance can lapse after 30 to 3,650 days without use.';
  if (!Number.isInteger(noticeDays) || noticeDays < 0 || noticeDays > 365) return 'The warning period must be 0 to 365 days.';
  if (expiryDays !== null && noticeDays >= expiryDays) return 'The warning period must be shorter than the time before a balance lapses.';
  return null;
}

/**
 * The rate a foreign wallet is carried at: what it is worth in the books' currency per unit it holds, to 8 decimals. Money
 * leaves the wallet at this rate, so what the business owed stays equal to what it booked. An empty wallet has no rate.
 */
export function averageRate(balanceCents: number, baseValue: bigint): string | null {
  if (balanceCents <= 0 || baseValue <= 0n) return null;
  // base is in 1/10000 units, the balance in 1/100 units, the rate in 1/100000000 units.
  const scaled = (baseValue * 1_000_000n * 2n + BigInt(balanceCents)) / (BigInt(balanceCents) * 2n);
  const whole = scaled / 100_000_000n;
  const frac = (scaled % 100_000_000n).toString().padStart(8, '0');
  return `${whole.toString()}.${frac}`;
}
