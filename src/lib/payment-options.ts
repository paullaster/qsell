/**
 * The fixed choices on the payment screens, as plain data shared by the server (which offers them
 * to an Autocomplete) and the screens (which show the label of a value already saved). Pure.
 */
export interface Choice {
  id: string;
  label: string;
  /** What the server said about this option when it was offered. */
  meta?: Record<string, string>;
}

export const PROVIDER_ENVIRONMENTS: readonly Choice[] = [
  { id: 'staging', label: 'Testing (sandbox)' },
  { id: 'production', label: 'Production' },
];

export const VERIFICATION_MODES: readonly Choice[] = [
  { id: 'standard', label: 'Standard: ask Safaricom about the request' },
  { id: 'strict', label: 'Strict: also check the transaction by its receipt' },
];

export const TIMEOUT_RESPONSES: readonly Choice[] = [
  { id: 'Completed', label: 'Let the payment complete' },
  { id: 'Cancelled', label: 'Cancel the payment' },
];

export const VALIDATION_ANSWERS: readonly Choice[] = [
  { id: 'accept_all', label: 'Accept every payment' },
  { id: 'known_reference', label: 'Accept only a known account number' },
  { id: 'reject_all', label: 'Reject every payment' },
];

export const ALLOCATION_MODES: readonly Choice[] = [
  { id: 'off', label: 'A person places it' },
  { id: 'by_customer_number', label: 'Put it on the customer whose number was given' },
];

export const METHOD_KINDS: readonly Choice[] = [
  { id: 'cash', label: 'Cash' },
  { id: 'bank_transfer', label: 'Bank transfer / EFT' },
  { id: 'bank_deposit', label: 'Bank deposit slip' },
  { id: 'cheque', label: 'Cheque' },
  { id: 'mobile_money', label: 'Mobile money' },
  { id: 'card', label: 'Card' },
  { id: 'gateway', label: 'Online gateway' },
  { id: 'other', label: 'Other' },
];

export const CHANNEL_KINDS: readonly Choice[] = [
  { id: 'paybill', label: 'Paybill number' },
  { id: 'till', label: 'Till number' },
  { id: 'account', label: 'Account number' },
  { id: 'other', label: 'Other number' },
];

export const MANUAL_OR_AUTOMATIC_REFUND: readonly Choice[] = [
  { id: 'manual', label: 'By hand, with evidence' },
  { id: 'automatic', label: 'Automatically through the provider (when available)' },
];

export const PAYMENT_SERVICES: readonly Choice[] = [
  { id: 'mpesa_daraja', label: 'M-Pesa (Daraja)' },
  { id: 'pesapal_v3', label: 'Pesapal' },
  { id: 'jenga_hq', label: 'Equity (Jenga)' },
  { id: 'kcb_buni', label: 'KCB (Buni)' },
];

export const EVENT_STATES = ['received', 'awaiting_verification', 'verified', 'consumed', 'unverified', 'mismatch', 'unmatched', 'rejected', 'ignored'] as const;
export const TRANSACTION_STATES = ['claimed', 'verified', 'review', 'consumed', 'rejected'] as const;

/** "awaiting_verification" -> "awaiting verification". */
export const words = (s: string): string => s.replace(/_/g, ' ');

export const stateChoices = (states: readonly string[]): Choice[] => states.map((s) => ({ id: s, label: words(s) }));

/** The label of a saved value, or the value itself when the list does not know it. */
export function labelOf(list: readonly Choice[], id: string | null | undefined): string | null {
  if (id === null || id === undefined || id === '') return null;
  return list.find((c) => c.id === id)?.label ?? id;
}

export interface MethodGl {
  bankAccountId: string;
  glAccountId: string;
  glLabel: string;
}

/** The G/L account every method on this bank account already posts to, when they all agree. */
export function suggestGlAccount(methods: readonly MethodGl[], bankAccountId: string): Choice | null {
  const used = new Map<string, string>();
  for (const m of methods) if (m.bankAccountId === bankAccountId) used.set(m.glAccountId, m.glLabel);
  if (used.size !== 1) return null;
  const only = used.entries().next();
  return only.done === true ? null : { id: only.value[0], label: only.value[1] };
}

/** What a payment method's refund setting is saved as. */
export function refundDestination(refundable: boolean, chosen: string | undefined): 'none' | 'manual' | 'automatic' {
  if (!refundable) return 'none';
  return chosen === 'automatic' ? 'automatic' : 'manual';
}

/** "Saved: ****1234" under a credential field that already has a value, else nothing. */
export function savedHint(masked: Record<string, string> | null, key: string): string | undefined {
  if (masked === null || !Object.hasOwn(masked, key) || masked[key] === '') return undefined;
  return `Saved: ${masked[key]}`;
}
