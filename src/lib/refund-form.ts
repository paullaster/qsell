/**
 * What the "new refund" form asks for and sends. Pure: the screen only collects text; the server
 * checks the amount against what is owed and the details against the customer's record.
 */
export interface DetailField {
  key: string;
  label: string;
  type?: string;
}

const BANK: DetailField[] = [{ key: 'bankName', label: 'Bank' }, { key: 'accountNumber', label: 'Account number' }, { key: 'accountName', label: 'Account name' }];

const DETAIL_FIELDS: Record<string, DetailField[]> = {
  mobile_money: [{ key: 'phone', label: 'Phone number to pay', type: 'tel' }],
  bank_transfer: BANK,
  bank_deposit: BANK,
  gateway: BANK,
  cheque: [{ key: 'payeeName', label: 'Cheque made out to' }],
  cash: [{ key: 'recipientName', label: 'Who will collect the cash' }],
};

/** The payout details to ask for, given the kind of the chosen payment method. */
export const payoutFields = (kind: string | undefined): DetailField[] => (kind !== undefined && Object.hasOwn(DETAIL_FIELDS, kind) ? DETAIL_FIELDS[kind] : []);

/** What the customer's phone gives as a starting payout detail. */
export const startingDetails = (phone: string | null | undefined): Record<string, string> => (phone !== null && phone !== undefined && phone !== '' ? { phone } : {});

export interface RefundForm {
  customerId: string | null;
  sourceKind: string | null;
  sourceId: string | null;
  amount: string;
  methodId: string | null;
  details: Record<string, string>;
  reasonCode: string | null;
  reasonText: string;
}

export function refundProblem(form: RefundForm): string | null {
  if (form.customerId === null) return 'Choose the customer.';
  if (form.sourceId === null) return 'Choose what the refund is taken from.';
  if (form.methodId === null) return 'Choose how it will be paid.';
  if (form.reasonCode === null) return 'Choose a reason.';
  return null;
}

/** A key that stays the same for the same refund, so a double click cannot make two. */
export const refundKey = (form: RefundForm, nonce: string): string => `${nonce}-${form.customerId ?? ''}-${form.sourceId ?? ''}-${form.amount.trim()}-${form.methodId ?? ''}`;

export function refundInput(form: RefundForm, nonce: string) {
  const text = form.reasonText.trim();
  return {
    customerId: form.customerId ?? '',
    sourceKind: form.sourceKind ?? '',
    sourceId: form.sourceId ?? '',
    amount: form.amount.trim(),
    paymentMethodId: form.methodId ?? '',
    payoutDetails: form.details,
    reasonCode: form.reasonCode ?? '',
    reasonText: text === '' ? undefined : text,
    idempotencyKey: refundKey(form, nonce),
  };
}

export const refundRoute = (id: string, submitError: string | null): string => (submitError === null ? `/admin/finance/refunds/${id}` : `/admin/finance/refunds/${id}?note=${encodeURIComponent(submitError)}`);
