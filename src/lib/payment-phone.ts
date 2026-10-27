import type { PaymentProvider } from '@/types/index';
import { has } from '@/lib/values';
import { toKenyanMsisdn } from '@/lib/phone';

/** The ways to pay that send a prompt to, or take a payment from, a mobile number. The customer may use any line, not only the one on their profile. */
export const PHONE_PAYMENT_METHODS = ['mpesa_daraja', 'kcb_buni', 'jenga_hq'] as const satisfies readonly PaymentProvider[];

export function paymentUsesPhone(method: PaymentProvider | '' | null | undefined): boolean {
  return PHONE_PAYMENT_METHODS.some((code) => code === method);
}

export type PaymentPhone = { ok: true; phone: string | null } | { ok: false; error: string };

/**
 * The number a payment is made from. The customer's own choice wins; if they chose none, the contact number is used.
 * A method that needs a phone refuses anything that is not a Kenyan mobile number, in words. Other methods keep a valid
 * number if one was given (it is recorded and offered to the provider) and ignore a bad one.
 */
export function resolvePaymentPhone(input: { method: PaymentProvider; contactPhone: string; paymentPhone?: string | null }): PaymentPhone {
  const chosen = has(input.paymentPhone) && input.paymentPhone.trim() !== '' ? input.paymentPhone : null;
  const msisdn = toKenyanMsisdn(chosen ?? input.contactPhone);
  if (paymentUsesPhone(input.method)) {
    if (msisdn !== null) return { ok: true, phone: msisdn };
    return {
      ok: false,
      error: chosen === null ? 'Your contact number is not a Kenyan mobile number. Enter the number to pay from, like 0712 345 678.' : 'That is not a Kenyan mobile number. Enter the number to pay from, like 0712 345 678.',
    };
  }
  return { ok: true, phone: chosen === null ? null : toKenyanMsisdn(chosen) };
}
