/** Shared payment domain types — provider-agnostic. */

export type PaymentProviderCode =
  | 'mpesa_daraja'
  | 'pesapal_v3'
  | 'jenga_hq'
  | 'kcb_buni';

export type PaymentProviderEnvironment = 'staging' | 'production';

export type PaymentAttemptStatus =
  | 'initiated'
  | 'pending'
  | 'awaiting_redirect'
  | 'successful'
  | 'failed'
  | 'cancelled'
  | 'expired';

/**
 * Exact status string copied from the callback payload.
 * mpesa_daraja / kcb_buni: Body.stkCallback.ResultCode ("0", "1", "1032", …).
 * pesapal_v3 / jenga_hq: the provider's status text ("COMPLETED", "success", …).
 * These fallbacks are ours, not a provider status, and only used when the
 * payload has no recognizable status field:
 * received | unmatched_token | error
 */
export type CallbackProcessingStatus = 'received' | 'unmatched_token' | 'error' | (string & {});

/**
 * Payment outcome derived from processing_status by the provider rulebook
 * in callback-status.ts. Never inferred from the HTTP status of the callback.
 * M-Pesa: ResultCode 0 = successful; any other ResultCode = failed.
 */
export type CallbackOutcome = 'successful' | 'failed' | 'pending' | 'unclassified';

/** AES-GCM sealed credentials stored in payment_provider_configs.credentials_encrypted */
export interface EncryptedCredentialsBlob {
  v: 1;
  iv: string; // base64
  tag: string; // base64
  ciphertext: string; // base64
}

export const PAYMENT_PROVIDER_META: Record<
  PaymentProviderCode,
  {
    label: string;
    description: string;
    defaultStagingBaseUrl: string;
    defaultProductionBaseUrl: string;
    callbackPathPrefix: string;
  }
> = {
  mpesa_daraja: {
    label: 'M-Pesa (Daraja)',
    description: 'Safaricom Daraja STK Push / Lipa Na M-Pesa',
    defaultStagingBaseUrl: 'https://sandbox.safaricom.co.ke',
    defaultProductionBaseUrl: 'https://api.safaricom.co.ke',
    callbackPathPrefix: '/api/payments/mpesa/daraja/stk/callback',
  },
  pesapal_v3: {
    label: 'Pesapal v3',
    description: 'Cards, bank transfer, and mobile money via Pesapal',
    defaultStagingBaseUrl: 'https://cybqa.pesapal.com/pesapalv3',
    defaultProductionBaseUrl: 'https://pay.pesapal.com/v3',
    callbackPathPrefix: '/api/payments/pesapal/ipn',
  },
  jenga_hq: {
    label: 'Jenga HQ',
    description: 'Equity Finserve Jenga API / Payment Gateway',
    defaultStagingBaseUrl: 'https://uat.finserve.africa',
    defaultProductionBaseUrl: 'https://api.finserve.africa',
    callbackPathPrefix: '/api/payments/jenga/callback',
  },
  kcb_buni: {
    label: 'KCB Buni',
    description: 'KCB Buni M-Pesa STK and collection APIs',
    defaultStagingBaseUrl: 'https://uat.buni.kcbgroup.com',
    defaultProductionBaseUrl: 'https://api.buni.kcbgroup.com',
    callbackPathPrefix: '/api/payments/kcb-buni/stk/callback',
  },
};

export type MpesaDarajaCredentials = {
  consumerKey: string;
  consumerSecret: string;
  shortcode: string;
  passkey: string;
  transactionType?: 'CustomerPayBillOnline' | 'CustomerBuyGoodsOnline';
};

export type PesapalCredentials = {
  consumerKey: string;
  consumerSecret: string;
  ipnId?: string;
};

export type JengaHqCredentials = {
  merchantCode: string;
  consumerSecret: string;
  apiKey: string;
  /** PEM private key used to sign requests */
  privateKeyPem: string;
};

export type KcbBuniCredentials = {
  consumerKey: string;
  consumerSecret: string;
  orgShortCode: string;
  orgPassKey?: string;
  invoiceNumber?: string;
  sharedShortCode?: boolean;
};

export type ProviderCredentialsMap = {
  mpesa_daraja: MpesaDarajaCredentials;
  pesapal_v3: PesapalCredentials;
  jenga_hq: JengaHqCredentials;
  kcb_buni: KcbBuniCredentials;
};
