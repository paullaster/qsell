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
