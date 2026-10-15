import { has } from '@/lib/values';

export type CustomerAccountType = 'cash' | 'credit';
export type CustomerBlock = 'none' | 'ship' | 'invoice' | 'all';

export const ACCOUNT_TYPES: readonly { id: CustomerAccountType; label: string }[] = [
  { id: 'cash', label: 'Cash (pays at once)' },
  { id: 'credit', label: 'Credit (pays later)' },
];

export const BLOCKS: readonly { id: CustomerBlock; label: string }[] = [
  { id: 'none', label: 'Not blocked' },
  { id: 'ship', label: 'Cannot be shipped to' },
  { id: 'invoice', label: 'Cannot be invoiced' },
  { id: 'all', label: 'Blocked from everything' },
];

export const isAccountType = (value: unknown): value is CustomerAccountType => value === 'cash' || value === 'credit';
export const isBlock = (value: unknown): value is CustomerBlock => value === 'none' || value === 'ship' || value === 'invoice' || value === 'all';

/** What a stored value means as an account type: anything but credit is cash. */
export const accountTypeOf = (value: unknown): CustomerAccountType => (value === 'credit' ? 'credit' : 'cash');
/** What a stored value means as a block: anything unknown is no block. */
export const blockOf = (value: unknown): CustomerBlock => (isBlock(value) ? value : 'none');

export const labelOfAccountType = (id: string): string => ACCOUNT_TYPES.find((t) => t.id === id)?.label ?? id;
export const labelOfBlock = (id: string): string => BLOCKS.find((b) => b.id === id)?.label ?? id;

export interface CustomerForm {
  profileId: string;
  profileLabel: string;
  name: string;
  email: string;
  phone: string;
  accountType: CustomerAccountType;
  creditLimit: string;
  paymentTermDays: string;
  buyerKraPin: string;
  transmitInvoicesToKra: boolean;
  notes: string;
}

export const emptyCustomerForm = (): CustomerForm => ({
  profileId: '',
  profileLabel: '',
  name: '',
  email: '',
  phone: '',
  accountType: 'cash',
  creditLimit: '0',
  paymentTermDays: '0',
  buyerKraPin: '',
  transmitInvoicesToKra: true,
  notes: '',
});

export interface NewCustomer {
  profileId: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  accountType: CustomerAccountType;
  creditLimit: number;
  paymentTermDays: number;
  buyerKraPin: string | null;
  transmitInvoicesToKra: boolean;
  notes: string | null;
}

const KRA_PIN = /^[AP]\d{9}[A-Z]$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const orNull = (text: string): string | null => (has(text.trim()) ? text.trim() : null);

/** The new-customer form as it is sent, or what is wrong with it. Cash customers never carry a credit limit or terms. */
export function newCustomerPayload(form: CustomerForm): { ok: true; payload: NewCustomer } | { ok: false; error: string } {
  const name = form.name.trim();
  if (!has(name)) return { ok: false, error: 'Customer name is required.' };
  const email = orNull(form.email)?.toLowerCase() ?? null;
  if (email !== null && !EMAIL.test(email)) return { ok: false, error: 'That email address does not look right.' };
  const pin = orNull(form.buyerKraPin)?.toUpperCase() ?? null;
  if (pin !== null && !KRA_PIN.test(pin)) return { ok: false, error: 'A KRA PIN is a letter (A or P), nine digits and a letter, like A123456789Z.' };
  let creditLimit = 0;
  let paymentTermDays = 0;
  if (form.accountType === 'credit') {
    creditLimit = form.creditLimit.trim() === '' ? Number.NaN : Number(form.creditLimit);
    paymentTermDays = form.paymentTermDays.trim() === '' ? Number.NaN : Number(form.paymentTermDays);
    if (!Number.isFinite(creditLimit) || creditLimit <= 0) return { ok: false, error: 'A credit customer needs a credit limit above zero.' };
    if (!Number.isInteger(paymentTermDays) || paymentTermDays < 0 || paymentTermDays > 365) return { ok: false, error: 'Payment terms are a whole number of days, 0 to 365.' };
  }
  return {
    ok: true,
    payload: {
      profileId: orNull(form.profileId),
      name,
      email,
      phone: orNull(form.phone),
      accountType: form.accountType,
      creditLimit,
      paymentTermDays,
      buyerKraPin: pin,
      transmitInvoicesToKra: form.transmitInvoicesToKra,
      notes: orNull(form.notes),
    },
  };
}
