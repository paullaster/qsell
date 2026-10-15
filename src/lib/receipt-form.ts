/**
 * What the "new receipt" form turns its fields into, and what it asks for from the chosen payment
 * method. Pure: the screen only collects text; the server checks everything again on save.
 */
export interface MethodTraits {
  currency: string;
  requiresReference: boolean;
  requiresEvidence: boolean;
  requiresCounterparty: boolean;
  min: string;
  max: string;
}

/** One fact the server attached to an option, or nothing. */
export const metaValue = (meta: Readonly<Record<string, string>> | undefined, key: string): string => (meta !== undefined && Object.hasOwn(meta, key) ? meta[key] : '');

/** The traits the server attached to a payment-method option. */
export function methodTraits(meta: Record<string, string> | undefined): MethodTraits | null {
  if (meta === undefined) return null;
  return {
    currency: metaValue(meta, 'currency'),
    requiresReference: meta.requiresReference === '1',
    requiresEvidence: meta.requiresEvidence === '1',
    requiresCounterparty: meta.requiresCounterparty === '1',
    min: metaValue(meta, 'min'),
    max: metaValue(meta, 'max'),
  };
}

/** True when the method's account is not held in the company's base currency. */
export const isForeign = (traits: MethodTraits | null, baseCurrency: string): boolean => traits !== null && traits.currency !== '' && traits.currency !== baseCurrency;

export function amountHint(traits: MethodTraits | null): string | undefined {
  if (traits === null || (traits.min === '' && traits.max === '')) return undefined;
  return `Allowed: ${traits.min === '' ? '0' : traits.min} to ${traits.max === '' ? 'no limit' : traits.max}`;
}

export interface Cheque {
  chequeNo: string;
  bank: string;
  drawer: string;
  chequeDate: string;
}

export interface ReceiptForm {
  customerId: string | null;
  methodId: string | null;
  traits: MethodTraits | null;
  amount: string;
  date: string;
  reference: string;
  payer: string;
  cheque: Cheque;
  narration: string;
  rate: string;
  deposit: boolean;
  allocate: 'oldest_first' | 'none';
}

/** The first thing missing before a receipt can be saved, in words, or null. */
export function receiptProblem(form: ReceiptForm): string | null {
  if (form.customerId === null) return 'Choose the customer who paid.';
  if (form.methodId === null) return 'Choose how the customer paid.';
  return null;
}

const blankToNull = (text: string): string | null => {
  const t = text.trim();
  return t === '' ? null : t;
};

export function receiptInput(form: ReceiptForm, idempotencyKey: string, baseCurrency: string) {
  const foreign = isForeign(form.traits, baseCurrency);
  return {
    customerId: form.customerId ?? '',
    paymentMethodId: form.methodId ?? '',
    amount: form.amount.trim(),
    paymentDate: form.date,
    currency: form.traits?.currency ?? baseCurrency,
    rate: foreign ? form.rate.trim() : undefined,
    externalReference: blankToNull(form.reference),
    payerName: blankToNull(form.payer),
    counterparty: form.traits?.requiresCounterparty === true ? form.cheque : {},
    narration: blankToNull(form.narration),
    idempotencyKey,
    isDeposit: form.deposit,
  };
}

/** What to do with the new receipt: nothing (draft), or post it and apply as chosen. */
export const postOptions = (form: ReceiptForm, post: boolean): { allocate: 'oldest_first' | 'none' } | undefined =>
  post ? { allocate: form.deposit ? 'none' : form.allocate } : undefined;

/** Where to go after saving: the receipt, carrying the reason when posting failed. */
export function receiptRoute(id: string, postError: string | null): string {
  return postError === null ? `/admin/finance/receipts/${id}` : `/admin/finance/receipts/${id}?posting_failed=${encodeURIComponent(postError)}`;
}

const balanceOf = (meta: Readonly<Record<string, string>> | undefined): string => {
  const v = metaValue(meta, 'balance');
  return v === '' ? '0' : v;
};

/** "Customer who owes 1,200" or "Cash customer". */
export const customerStanding = (meta: Record<string, string> | undefined, formatMoney: (v: string) => string): string =>
  meta?.accountType === 'credit' ? `Credit customer · owes ${formatMoney(balanceOf(meta))}` : 'Cash customer';
