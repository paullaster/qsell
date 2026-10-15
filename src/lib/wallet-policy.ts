/**
 * The wallet policy page: which rule is in force, how it reads, what the edit form starts with and
 * what it sends. Pure: the clock is passed in.
 */
export interface PolicyRow {
  groupCode: string | null;
  effectiveFrom: string;
  walletEnabled: boolean;
  allowDeposits: boolean;
  overpaymentDefault: 'wallet' | 'hold' | 'ask';
  autoApply: 'never' | 'oldest_first';
  creditNoteExcess: 'wallet' | 'ask';
  refundsEnabled: boolean;
  walletCashOut: boolean;
  maxBalance: string | null;
  label: string;
}

export const OVERPAYMENT_MODES = [
  { id: 'wallet', label: 'Put it in the wallet' },
  { id: 'hold', label: 'Leave it unapplied on the account' },
  { id: 'ask', label: 'Leave it unapplied until someone chooses' },
] as const;

export const AUTO_APPLY_MODES = [
  { id: 'never', label: 'Use the wallet only when someone chooses' },
  { id: 'oldest_first', label: 'Pay from the wallet automatically' },
] as const;

export const CREDIT_NOTE_MODES = [
  { id: 'ask', label: 'Wait on a list until someone decides' },
  { id: 'wallet', label: 'Put it in the wallet' },
] as const;

const labelIn = (list: readonly { id: string; label: string }[], id: string): string => list.find((x) => x.id === id)?.label ?? id;
export const choiceOf = (list: readonly { id: string; label: string }[], id: string): { id: string; label: string } => ({ id, label: labelIn(list, id) });

/** The newest rule of each scope that has started by `today`; that is the one in force. */
export function inForce(rows: readonly PolicyRow[], today: string): Map<string, PolicyRow> {
  const out = new Map<string, PolicyRow>();
  const started = rows.filter((r) => r.effectiveFrom <= today).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  for (const r of started) out.set(r.groupCode ?? '', r);
  return out;
}

/** One sentence on what a rule does. */
export function describePolicy(r: PolicyRow | undefined): string {
  if (r === undefined) return 'Not set: there is no wallet, and money paid beyond what is owed stays on the account.';
  if (!r.walletEnabled) return 'Off.';
  const overpay = labelIn(OVERPAYMENT_MODES, r.overpaymentDefault).toLowerCase();
  const auto = r.autoApply === 'oldest_first' ? 'Paid from automatically on credit invoices.' : 'Used only when someone chooses.';
  const deposits = r.allowDeposits ? '' : ' No advance deposits.';
  const max = r.maxBalance === null || r.maxBalance === '' ? '' : ` Holds at most ${r.maxBalance}.`;
  return `On. Overpayments: ${overpay}. ${auto}${deposits}${max}`;
}

export interface PolicyForm {
  groupCode: string | null;
  walletEnabled: boolean;
  allowDeposits: boolean;
  overpaymentDefault: string;
  autoApply: string;
  creditNoteExcess: string;
  refundsEnabled: boolean;
  walletCashOut: boolean;
  maxBalance: string;
  label: string;
}

/** What the form starts with: the scope's own rule, else the whole business's, else the safe defaults. */
export function startingForm(groupCode: string | null, own: PolicyRow | undefined, company: PolicyRow | undefined): PolicyForm {
  const r = own ?? company;
  return {
    groupCode,
    walletEnabled: r?.walletEnabled ?? false,
    allowDeposits: r?.allowDeposits ?? true,
    overpaymentDefault: r?.overpaymentDefault ?? 'ask',
    autoApply: r?.autoApply ?? 'never',
    creditNoteExcess: r?.creditNoteExcess ?? 'ask',
    refundsEnabled: r?.refundsEnabled ?? true,
    walletCashOut: r?.walletCashOut ?? false,
    maxBalance: r?.maxBalance ?? '',
    label: company?.label ?? 'Wallet',
  };
}

export function policyInput(form: PolicyForm) {
  const max = form.maxBalance.trim();
  return {
    ...form,
    overpaymentDefault: form.overpaymentDefault as PolicyRow['overpaymentDefault'],
    autoApply: form.autoApply as PolicyRow['autoApply'],
    creditNoteExcess: form.creditNoteExcess as PolicyRow['creditNoteExcess'],
    maxBalance: max === '' ? null : max,
  };
}
