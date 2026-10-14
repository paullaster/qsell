import type { PaymentProvider } from '@/types/index';

/** How a payment method is named to people. */
export const PAYMENT_METHOD_LABELS: Record<PaymentProvider, string> = {
  mpesa_daraja: 'M-Pesa',
  pesapal_v3: 'Pesapal',
  jenga_hq: 'Jenga',
  kcb_buni: 'KCB Buni',
  card_direct: 'Card',
  on_account: 'On account',
};

/** The methods a quote can be paid by; "on account" only for a customer with a credit account. */
export const QUOTE_PAYMENT_METHODS: readonly PaymentProvider[] = [
  'mpesa_daraja',
  'pesapal_v3',
  'jenga_hq',
  'kcb_buni',
];

export const methodLabel = (method: string): string =>
  Object.hasOwn(PAYMENT_METHOD_LABELS, method)
    ? PAYMENT_METHOD_LABELS[method as PaymentProvider]
    : method;
