/** The secret values each service needs. They are sealed in the database and never read back. */
export const CREDENTIAL_FIELDS: Record<string, { key: string; label: string; multiline?: boolean }[]> = {
  mpesa_daraja: [
    { key: 'consumerKey', label: 'Consumer key' },
    { key: 'consumerSecret', label: 'Consumer secret' },
    { key: 'shortcode', label: 'Business shortcode (paybill, or the till\'s head-office shortcode)' },
    { key: 'passkey', label: 'Lipa na M-Pesa passkey' },
    { key: 'initiatorName', label: 'API operator name (for status checks, pay-outs, reversals; optional until needed)' },
    { key: 'initiatorPassword', label: 'API operator password' },
    { key: 'certificate', label: 'Safaricom certificate (PEM, from the Daraja portal)', multiline: true },
  ],
  pesapal_v3: [
    { key: 'consumerKey', label: 'Consumer key' },
    { key: 'consumerSecret', label: 'Consumer secret' },
    { key: 'ipnId', label: 'IPN id (optional)' },
  ],
  jenga_hq: [
    { key: 'merchantCode', label: 'Merchant code' },
    { key: 'consumerSecret', label: 'Consumer secret' },
    { key: 'apiKey', label: 'API key' },
    { key: 'privateKeyPem', label: 'Private key (PEM)', multiline: true },
  ],
  kcb_buni: [
    { key: 'consumerKey', label: 'Consumer key' },
    { key: 'consumerSecret', label: 'Consumer secret' },
    { key: 'orgShortCode', label: 'Organisation shortcode' },
    { key: 'orgPassKey', label: 'Organisation passkey (optional)' },
    { key: 'invoiceNumber', label: 'Invoice / account number (optional)' },
  ],
};

export const CAPABILITY_LABEL: Record<string, string> = {
  collect: 'Collect payments',
  payout: 'Pay out',
  reverse: 'Reverse',
  status_query: 'Status check',
  register_urls: 'Register URLs',
  balance: 'Account balance',
  statement: 'Statements',
};
