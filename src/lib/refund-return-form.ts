/**
 * What the "money came back" form asks for and sends. Pure: the screen collects text; the server checks the amount against
 * what was paid, the reference against money already recorded, and the new details against the customer's record.
 */
export interface ReturnForm {
  /** Left empty to mean everything that can still come back. */
  amount: string;
  reference: string;
  returnedOn: string;
  intoMethodId: string | null;
  reasonCode: string | null;
  reasonText: string;
  replacementMethodId: string | null;
  replacementDetails: Record<string, string>;
}

export function returnProblem(form: ReturnForm, returnable: string, today: string): string | null {
  const amount = form.amount.trim();
  if (amount !== '' && !(Number(amount) > 0)) return 'The amount must be more than zero.';
  if (amount !== '' && Number(amount) > Number(returnable)) return `Only ${returnable} of this refund can still come back.`;
  if (form.reference.trim() === '') return 'Enter the reference the bank or M-Pesa gave for the money coming back.';
  if (form.returnedOn === '' || form.returnedOn > today) return 'The date it came back cannot be in the future.';
  if (form.intoMethodId === null) return 'Choose the payment method the money came back into.';
  if (form.reasonCode === null) return 'Choose why it came back.';
  if (form.replacementMethodId === null) return 'Choose how the customer will be paid this time.';
  return null;
}

export function returnInput(form: ReturnForm) {
  const text = form.reasonText.trim();
  const amount = form.amount.trim();
  return {
    amount: amount === '' ? undefined : amount,
    returnedOn: form.returnedOn,
    reference: form.reference.trim(),
    receivedIntoMethodId: form.intoMethodId ?? '',
    reasonCode: form.reasonCode ?? '',
    reasonText: text === '' ? undefined : text,
    replacement: { paymentMethodId: form.replacementMethodId ?? '', payoutDetails: form.replacementDetails },
  };
}
