/**
 * The bank and cash accounts screen: kinds and their words, and what the add/edit form starts with
 * and sends. Pure.
 */
export const BANK_KINDS = [
  { id: 'bank', label: 'Bank account' },
  { id: 'cash', label: 'Cash (till or drawer)' },
  { id: 'mobile_money', label: 'Mobile-money account (paybill, till)' },
  { id: 'clearing', label: 'Clearing account (money on its way)' },
] as const;

export type BankKind = (typeof BANK_KINDS)[number]['id'];

export const kindLabel = (kind: string): string => BANK_KINDS.find((k) => k.id === kind)?.label ?? kind;

export interface AccountForm {
  id: string | null;
  code: string;
  name: string;
  kind: BankKind;
  currency: string;
  fee: { id: string; label: string } | null;
  bankName: string;
  accountNumber: string;
  paybill: string;
}

export const blankAccountForm = (currency: string): AccountForm => ({ id: null, code: '', name: '', kind: 'bank', currency, fee: null, bankName: '', accountNumber: '', paybill: '' });

export interface AccountLike {
  id: string;
  code: string;
  name: string;
  kind: BankKind;
  currency: string;
  feeGlAccountId: string | null;
  feeGlLabel: string | null;
  details: Readonly<Record<string, string>>;
}

const detail = (details: Readonly<Record<string, string>>, key: string): string => (Object.hasOwn(details, key) ? details[key] : '');

export function editAccountForm(a: AccountLike): AccountForm {
  return {
    id: a.id,
    code: a.code,
    name: a.name,
    kind: a.kind,
    currency: a.currency,
    fee: a.feeGlAccountId === null ? null : { id: a.feeGlAccountId, label: a.feeGlLabel ?? a.feeGlAccountId },
    bankName: detail(a.details, 'bankName'),
    accountNumber: detail(a.details, 'accountNumber'),
    paybill: detail(a.details, 'paybill'),
  };
}

/** Only the facts that were typed, and only those that belong to the kind. */
export function accountDetails(form: AccountForm): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (key: string, value: string) => {
    const t = value.trim();
    if (t !== '') out[key] = t;
  };
  if (form.kind === 'bank') {
    put('bankName', form.bankName);
    put('accountNumber', form.accountNumber);
  }
  if (form.kind === 'mobile_money') put('paybill', form.paybill);
  return out;
}

export function accountInput(form: AccountForm) {
  return { name: form.name, kind: form.kind, currency: form.currency.toUpperCase(), feeGlAccountId: form.fee?.id ?? null, details: accountDetails(form) };
}

/** "Paybill / till" or "Account no." with its value, when the account has either. */
export function accountNumberLine(details: Readonly<Record<string, string>>): { label: string; value: string } | null {
  const paybill = detail(details, 'paybill');
  if (paybill !== '') return { label: 'Paybill / till', value: paybill };
  const number = detail(details, 'accountNumber');
  return number === '' ? null : { label: 'Account no.', value: number };
}
