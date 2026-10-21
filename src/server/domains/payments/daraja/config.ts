import { engineSettings, type EngineSettings } from '../engine/settings';

import { asRecord, has } from '@/lib/values';

export type C2bValidation = 'accept_all' | 'known_reference' | 'reject_all';

export interface DarajaSettings extends EngineSettings {
  c2b: {
    /** What Safaricom does when our validation address does not answer in time. */
    responseType: 'Completed' | 'Cancelled';
    /** What our validation address answers (only used when external validation is switched on for the shortcode). */
    validation: C2bValidation;
    /** Payments made straight to the paybill or till: put them on a customer's account by themselves, or leave them for a person. */
    autoAllocate: 'off' | 'by_customer_number';
    apiVersion: 'v1' | 'v2';
  };
  /** Which operations may be run, and the most one may move. Money-out operations are off until switched on here. */
  operations: Record<string, { enabled: boolean; maxAmount: string | null }>;
  pull: { registered: boolean; nominatedNumber: string | null };
  /** The most that may be requested for payout through this provider in any 24 hours. Empty = no cap. */
  dailyPayoutLimit: string | null;
}

/** Safe by default: money can come in, nothing can go out, until someone says so. */
export const OPERATION_DEFAULTS: Record<string, boolean> = {
  stk_push: true,
  stk_query: true,
  c2b_register_urls: true,
  c2b_simulate: true,
  transaction_status: true,
  pull_register: true,
  pull_query: true,
  qr_generate: true,
  account_balance: true,
  reversal: false,
  b2c: false,
  b2c_topup: false,
  b2pochi: false,
  ratiba_create: false,
  b2b_paybill: false,
  b2b_buygoods: false,
  tax_remittance: false,
  b2b_express: false,
  bill_optin: true,
  bill_update_optin: true,
  bill_invoice: true,
  bill_invoice_bulk: true,
  bill_cancel: true,
  bill_cancel_bulk: true,
  bill_acknowledge: true,
};

const rec = asRecord;

export function darajaSettings(raw: unknown): DarajaSettings {
  const base = engineSettings(raw);
  const s = rec(raw);
  const c2b = rec(s.c2b);
  const ops = rec(s.operations);
  const pull = rec(s.pull);
  const operations: DarajaSettings['operations'] = {};
  for (const [code, on] of Object.entries(OPERATION_DEFAULTS)) {
    const o = rec(ops[code]);
    operations[code] = {
      enabled: typeof o.enabled === 'boolean' ? o.enabled : on,
      maxAmount: typeof o.maxAmount === 'string' && /^\d+(\.\d{1,2})?$/.test(o.maxAmount) ? o.maxAmount : null,
    };
  }
  return {
    ...base,
    c2b: {
      responseType: c2b.responseType === 'Cancelled' ? 'Cancelled' : 'Completed',
      validation: c2b.validation === 'known_reference' || c2b.validation === 'reject_all' ? c2b.validation : 'accept_all',
      autoAllocate: c2b.autoAllocate === 'by_customer_number' ? 'by_customer_number' : 'off',
      apiVersion: c2b.apiVersion === 'v1' ? 'v1' : 'v2',
    },
    operations,
    dailyPayoutLimit: typeof s.dailyPayoutLimit === 'string' && /^\d+(\.\d{1,2})?$/.test(s.dailyPayoutLimit) ? s.dailyPayoutLimit : null,
    pull: { registered: pull.registered === true, nominatedNumber: typeof pull.nominatedNumber === 'string' && has(pull.nominatedNumber.trim()) ? pull.nominatedNumber.trim() : null },
  };
}
