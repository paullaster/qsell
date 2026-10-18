/**
 * What the "change a customer's credit" form asks for and sends. Pure: the screen collects text; the server checks the amount
 * against what is owed or held, and who may decide.
 */
export type AdjustmentKind = 'waive_excess' | 'wallet_increase' | 'wallet_decrease';

export interface AdjustmentForm {
  customerId: string | null;
  kind: AdjustmentKind | null;
  sourceKind: string | null;
  sourceId: string | null;
  amount: string;
  /** For the wallet kinds: the wallet's currency; empty means the books' own. */
  currency: string;
  reasonCode: string | null;
  reasonText: string;
}

export const isKind = (v: string | null | undefined): v is AdjustmentKind => v === 'waive_excess' || v === 'wallet_increase' || v === 'wallet_decrease';

export function adjustmentProblem(form: AdjustmentForm): string | null {
  if (form.customerId === null) return 'Choose the customer.';
  if (form.kind === null) return 'Choose what to do.';
  if (form.kind === 'waive_excess' && form.sourceId === null) return 'Choose which credit is being given up.';
  if (!(Number(form.amount) > 0)) return 'Enter an amount above zero.';
  if (form.kind !== 'waive_excess' && form.currency.trim() !== '' && !/^[A-Za-z]{3}$/.test(form.currency.trim())) return 'A currency is three letters, such as KES.';
  if (form.reasonCode === null) return 'Choose a reason.';
  return null;
}

/** A key that stays the same for the same request, so a double click cannot make two. */
export const adjustmentKey = (form: AdjustmentForm, nonce: string): string => `${nonce}-${form.customerId ?? ''}-${form.kind ?? ''}-${form.sourceId ?? ''}-${form.amount.trim()}-${form.currency.trim().toUpperCase()}`;

export function adjustmentInput(form: AdjustmentForm, nonce: string) {
  const text = form.reasonText.trim();
  return {
    kind: form.kind ?? 'wallet_increase',
    customerId: form.customerId ?? '',
    sourceKind: form.kind === 'waive_excess' ? (form.sourceKind ?? undefined) : undefined,
    sourceId: form.kind === 'waive_excess' ? (form.sourceId ?? undefined) : undefined,
    amount: form.amount.trim(),
    currency: form.kind !== 'waive_excess' && form.currency.trim() !== '' ? form.currency.trim().toUpperCase() : undefined,
    reasonCode: form.reasonCode ?? '',
    reasonText: text === '' ? undefined : text,
    idempotencyKey: adjustmentKey(form, nonce),
  };
}

/** What each kind does, in a sentence, for the form and the detail page. */
export const KIND_SENTENCE: Record<AdjustmentKind | 'wallet_expiry', string> = {
  waive_excess: 'The business stops owing this credit to the customer. It becomes income and cannot be refunded afterwards.',
  wallet_increase: 'Credit is added to the customer\'s wallet without any money coming in (goodwill, a correction). It is a cost to the business.',
  wallet_decrease: 'Credit is taken off the customer\'s wallet (a correction, or a balance written off). It becomes income.',
  wallet_expiry: 'The balance lapsed because the customer did not use it for as long as the wallet policy allows.',
};

export const wordsOf = (s: string): string => s.replace(/_/g, ' ');

export const adjustmentRoute = (id: string): string => `/admin/finance/receivables/credit-adjustments/${id}`;

export const outcomeMessage = (status: string): string => {
  if (status === 'pending_approval') return 'Sent for approval. Nothing changes until it is approved.';
  if (status === 'applied') return 'Done.';
  return 'Asked for. Someone other than you has to decide it.';
};
