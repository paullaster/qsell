
import { has } from '@/lib/has';
import { firstFilled, readText } from '@/lib/values';
/**
 * Everything Daraja can do, described once. The forms on screen, the checks on what is typed, the
 * settings (which operations are on, how much each may move) and the permissions are all generated
 * from this list, so adding an operation here adds it everywhere.
 */
export type DarajaOperationCode =
  | 'stk_push'
  | 'stk_query'
  | 'c2b_register_urls'
  | 'c2b_simulate'
  | 'transaction_status'
  | 'pull_register'
  | 'pull_query'
  | 'qr_generate'
  | 'account_balance'
  | 'reversal'
  | 'b2c'
  | 'b2b_paybill'
  | 'b2b_buygoods'
  | 'tax_remittance'
  | 'b2b_express'
  | 'bill_optin'
  | 'bill_update_optin'
  | 'bill_invoice'
  | 'bill_invoice_bulk'
  | 'bill_cancel'
  | 'bill_cancel_bulk'
  | 'bill_acknowledge';

export interface FieldSpec {
  key: string;
  label: string;
  type: 'text' | 'number' | 'phone' | 'select' | 'textarea' | 'date';
  required?: boolean;
  maxLength?: number;
  minLength?: number;
  min?: number;
  max?: number;
  /** Whole shillings only (M-Pesa moves whole amounts; a rounded amount would not match what we verify). */
  whole?: boolean;
  /** A regular expression the whole value must match, with the words to say when it does not. */
  pattern?: string;
  patternHint?: string;
  options?: [string, string][];
  hint?: string;
  placeholder?: string;
  defaultValue?: string;
}

export interface OperationInfo {
  code: DarajaOperationCode;
  label: string;
  /** Where it appears: collect money, look something up, set the platform up, pay money out, or bills. */
  group: 'collect' | 'query' | 'admin' | 'pay_out' | 'bills';
  description: string;
  /** The platform answers later, on our result address (or the callback address of the request). */
  async: boolean;
  moneyOut: boolean;
  needsInitiator: boolean;
  /** Runs for one paybill or till: the screen asks which. */
  needsMethod: boolean;
  /** Only meaningful against Safaricom's sandbox. */
  sandboxOnly?: boolean;
  /** Started by the system itself (not offered as a form). */
  internal?: boolean;
  fields: FieldSpec[];
}

const PHONE: Pick<FieldSpec, 'pattern' | 'patternHint'> = { pattern: '^(\\+?254|0)?[17]\\d{8}$', patternHint: 'a Kenyan mobile number such as 0712345678' };
const REMARKS: FieldSpec = { key: 'remarks', label: 'Remarks', type: 'text', required: true, minLength: 2, maxLength: 100, hint: 'Kept with the request and shown by Safaricom.' };
const AMOUNT = (over: Partial<FieldSpec> = {}): FieldSpec => ({ key: 'amount', label: 'Amount (KES)', type: 'number', required: true, min: 1, ...over });

export const DARAJA_OPERATIONS: Record<DarajaOperationCode, OperationInfo> = {
  stk_push: { code: 'stk_push', label: 'M-Pesa Express (STK Push)', group: 'collect', description: 'Asks a customer to pay on their phone. Started by checkout.', async: true, moneyOut: false, needsInitiator: false, needsMethod: false, internal: true, fields: [] },
  stk_query: { code: 'stk_query', label: 'Check an STK Push', group: 'query', description: 'Asks Safaricom what became of a prompt. Used to confirm payments.', async: false, moneyOut: false, needsInitiator: false, needsMethod: false, internal: true, fields: [] },
  c2b_register_urls: { code: 'c2b_register_urls', label: 'Register paybill/till callback addresses (C2B)', group: 'admin', description: 'Tells Safaricom where to announce payments made straight to this paybill or till. In production this can be done once; changing it later goes through Safaricom.', async: false, moneyOut: false, needsInitiator: false, needsMethod: true, fields: [{ key: 'responseType', label: 'If our validation does not answer', type: 'select', options: [['', 'Use the provider setting'], ['Completed', 'Let the payment complete'], ['Cancelled', 'Cancel the payment']] }] },
  c2b_simulate: { code: 'c2b_simulate', label: 'Simulate a customer payment (sandbox only)', group: 'admin', description: "Makes Safaricom's testing environment announce a payment, to try the whole path.", async: false, moneyOut: false, needsInitiator: false, needsMethod: true, sandboxOnly: true, fields: [AMOUNT(), { key: 'billRef', label: 'Account number', type: 'text', maxLength: 20 }, { key: 'phone', label: 'Test phone', type: 'phone', defaultValue: '254708374149', ...PHONE }, { key: 'commandId', label: 'Pay to', type: 'select', options: [['CustomerPayBillOnline', 'A paybill'], ['CustomerBuyGoodsOnline', 'A till']] }] },
  transaction_status: { code: 'transaction_status', label: 'Check a transaction by its M-Pesa code', group: 'query', description: "Asks Safaricom for its own record of a transaction. The answer arrives a moment later.", async: true, moneyOut: false, needsInitiator: true, needsMethod: true, fields: [{ key: 'transactionId', label: 'M-Pesa transaction code', type: 'text', required: true, pattern: '^[A-Za-z0-9]{8,20}$', patternHint: 'the code from the M-Pesa message, such as NLJ7RT61SV', maxLength: 20 }] },
  pull_register: { code: 'pull_register', label: 'Register for Pull Transactions', group: 'admin', description: 'One-time: lets us list the payments Safaricom received (last 48 hours) to find any whose callback never arrived.', async: false, moneyOut: false, needsInitiator: false, needsMethod: true, fields: [{ key: 'nominatedNumber', label: 'Nominated phone number on the M-Pesa portal', type: 'phone', required: true, ...PHONE }] },
  pull_query: { code: 'pull_query', label: 'Pull transactions (last 48 hours)', group: 'query', description: 'Lists what Safaricom received for a paybill or till in a window.', async: false, moneyOut: false, needsInitiator: false, needsMethod: true, fields: [{ key: 'startDate', label: 'From', type: 'text', required: true, pattern: '^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}(:\\d{2})?$', patternHint: 'YYYY-MM-DD HH:MM', placeholder: '2026-10-13 08:00' }, { key: 'endDate', label: 'To', type: 'text', required: true, pattern: '^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}(:\\d{2})?$', patternHint: 'YYYY-MM-DD HH:MM', placeholder: '2026-10-13 18:00' }] },
  qr_generate: { code: 'qr_generate', label: 'Dynamic QR code', group: 'collect', description: 'A QR code a customer scans to pay a till, paybill or phone number.', async: false, moneyOut: false, needsInitiator: false, needsMethod: true, fields: [{ key: 'merchantName', label: 'Name shown', type: 'text', required: true, maxLength: 26 }, { key: 'refNo', label: 'Reference', type: 'text', required: true, maxLength: 12 }, AMOUNT(), { key: 'trxCode', label: 'Pay to', type: 'select', required: true, options: [['BG', 'A till (Buy Goods)'], ['PB', 'A paybill'], ['SM', 'A phone number'], ['WA', 'Cash at an agent']] }] },
  account_balance: { code: 'account_balance', label: 'Account balance', group: 'query', description: "Asks Safaricom for the balances of a paybill or till's accounts.", async: true, moneyOut: false, needsInitiator: true, needsMethod: true, fields: [] },
  reversal: { code: 'reversal', label: 'Reverse a customer payment', group: 'pay_out', description: 'Returns a customer payment (paid to a paybill or till) to the customer through M-Pesa. Needs approval. Cannot be undone.', async: true, moneyOut: true, needsInitiator: true, needsMethod: true, fields: [{ key: 'transactionId', label: 'M-Pesa transaction code to reverse', type: 'text', required: true, pattern: '^[A-Za-z0-9]{8,20}$', patternHint: 'the code of the customer payment', maxLength: 20 }, AMOUNT({ hint: 'No more than the payment.' }), REMARKS] },
  b2c: { code: 'b2c', label: 'Pay a customer (B2C)', group: 'pay_out', description: "Sends money from the business to a customer's M-Pesa. Needs approval. Between KES 10 and 250,000 per payment.", async: true, moneyOut: true, needsInitiator: true, needsMethod: true, fields: [{ key: 'phone', label: 'Customer phone', type: 'phone', required: true, ...PHONE }, AMOUNT({ min: 10, max: 250000, whole: true }), { key: 'commandId', label: 'Kind of payment', type: 'select', required: true, defaultValue: 'BusinessPayment', options: [['BusinessPayment', 'Business payment'], ['SalaryPayment', 'Salary payment'], ['PromotionPayment', 'Promotion payment']] }, REMARKS, { key: 'occasion', label: 'Occasion', type: 'text', maxLength: 100 }] },
  b2b_paybill: { code: 'b2b_paybill', label: 'Pay a paybill (Business PayBill)', group: 'pay_out', description: "Pays another business's paybill from this account. Needs approval.", async: true, moneyOut: true, needsInitiator: true, needsMethod: true, fields: [{ key: 'partyB', label: 'Paybill to pay', type: 'text', required: true, pattern: '^\\d{5,7}$', patternHint: 'a 5 to 7 digit paybill number', maxLength: 7 }, AMOUNT({ whole: true }), { key: 'accountReference', label: 'Account number', type: 'text', required: true, maxLength: 13 }, { key: 'requester', label: 'On behalf of (phone, optional)', type: 'phone', ...PHONE }, REMARKS] },
  b2b_buygoods: { code: 'b2b_buygoods', label: 'Pay a till (Business Buy Goods)', group: 'pay_out', description: "Pays another business's till from this account. Needs approval.", async: true, moneyOut: true, needsInitiator: true, needsMethod: true, fields: [{ key: 'partyB', label: 'Till to pay', type: 'text', required: true, pattern: '^\\d{5,7}$', patternHint: 'a 5 to 7 digit till number', maxLength: 7 }, AMOUNT({ whole: true }), { key: 'accountReference', label: 'Reference', type: 'text', required: true, maxLength: 13 }, { key: 'requester', label: 'On behalf of (phone, optional)', type: 'phone', ...PHONE }, REMARKS] },
  tax_remittance: { code: 'tax_remittance', label: 'Pay tax to KRA', group: 'pay_out', description: 'Pays a KRA payment registration number (PRN) from this account. Needs approval.', async: true, moneyOut: true, needsInitiator: true, needsMethod: true, fields: [{ key: 'prn', label: 'KRA payment registration number (PRN)', type: 'text', required: true, pattern: '^[A-Za-z0-9]{6,13}$', patternHint: 'the PRN KRA issued (up to 13 letters and digits)', maxLength: 13 }, AMOUNT({ whole: true }), REMARKS] },
  b2b_express: { code: 'b2b_express', label: 'Ask a business to pay us (B2B Express Checkout)', group: 'collect', description: "Sends a prompt to another business's till operator to pay this paybill.", async: true, moneyOut: false, needsInitiator: false, needsMethod: true, fields: [{ key: 'primaryShortCode', label: "The paying business's till", type: 'text', required: true, pattern: '^\\d{5,7}$', patternHint: 'a 5 to 7 digit till number', maxLength: 7 }, AMOUNT(), { key: 'paymentRef', label: 'Reference shown on their prompt', type: 'text', required: true, maxLength: 20 }, { key: 'partnerName', label: 'Our name as they know it', type: 'text', required: true, maxLength: 40 }] },
  bill_optin: { code: 'bill_optin', label: 'Bill Manager: sign up this paybill', group: 'bills', description: 'One-time: lets this paybill send invoices and receipts through Bill Manager.', async: false, moneyOut: false, needsInitiator: false, needsMethod: true, fields: [{ key: 'email', label: 'Business email shown on invoices', type: 'text', required: true, maxLength: 100, pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$', patternHint: 'an email address' }, { key: 'officialContact', label: 'Business phone shown on invoices', type: 'phone', required: true, ...PHONE }, { key: 'sendReminders', label: 'Send payment reminders', type: 'select', required: true, defaultValue: '1', options: [['1', 'Yes'], ['0', 'No']] }] },
  bill_update_optin: { code: 'bill_update_optin', label: 'Bill Manager: change the details', group: 'bills', description: 'Changes the contact details and reminders of the sign-up.', async: false, moneyOut: false, needsInitiator: false, needsMethod: true, fields: [{ key: 'email', label: 'Business email', type: 'text', required: true, maxLength: 100, pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$', patternHint: 'an email address' }, { key: 'officialContact', label: 'Business phone', type: 'phone', required: true, ...PHONE }, { key: 'sendReminders', label: 'Send payment reminders', type: 'select', required: true, defaultValue: '1', options: [['1', 'Yes'], ['0', 'No']] }] },
  bill_invoice: { code: 'bill_invoice', label: 'Bill Manager: send an invoice', group: 'bills', description: 'Sends one invoice to a customer by SMS, with reminders.', async: false, moneyOut: false, needsInitiator: false, needsMethod: true, fields: [{ key: 'externalReference', label: 'Our invoice number', type: 'text', required: true, maxLength: 40 }, { key: 'billedFullName', label: 'Customer name', type: 'text', required: true, maxLength: 60 }, { key: 'billedPhoneNumber', label: 'Customer phone', type: 'phone', required: true, ...PHONE }, { key: 'billedPeriod', label: 'Billing period', type: 'text', required: true, maxLength: 30, placeholder: 'October 2026' }, { key: 'invoiceName', label: 'What it is for', type: 'text', required: true, maxLength: 60 }, { key: 'dueDate', label: 'Due date', type: 'date', required: true }, { key: 'accountReference', label: 'Account number to pay to', type: 'text', required: true, maxLength: 20 }, AMOUNT()] },
  bill_invoice_bulk: { code: 'bill_invoice_bulk', label: 'Bill Manager: send many invoices', group: 'bills', description: 'Up to 1,000 invoices in one go. Started from a list, not a form.', async: false, moneyOut: false, needsInitiator: false, needsMethod: true, internal: true, fields: [] },
  bill_cancel: { code: 'bill_cancel', label: 'Bill Manager: cancel an invoice', group: 'bills', description: 'Cancels an invoice that has not been paid.', async: false, moneyOut: false, needsInitiator: false, needsMethod: true, fields: [{ key: 'externalReference', label: 'Our invoice number', type: 'text', required: true, maxLength: 40 }] },
  bill_cancel_bulk: { code: 'bill_cancel_bulk', label: 'Bill Manager: cancel many invoices', group: 'bills', description: 'Cancels several unpaid invoices.', async: false, moneyOut: false, needsInitiator: false, needsMethod: true, internal: true, fields: [] },
  bill_acknowledge: { code: 'bill_acknowledge', label: 'Bill Manager: acknowledge a payment', group: 'bills', description: 'Tells Bill Manager a payment was received, so the customer gets a receipt. Done by the system after a payment is confirmed.', async: false, moneyOut: false, needsInitiator: false, needsMethod: true, internal: true, fields: [] },
};

export const MONEY_OUT_OPERATIONS = (Object.values(DARAJA_OPERATIONS) as OperationInfo[]).filter((o) => o.moneyOut).map((o) => o.code);

/** Checks what was typed against the operation's own field list. Returns the cleaned input, or the first problem in words. */
export function validateOperationInput(info: OperationInfo, raw: Record<string, unknown>): { ok: true; input: Record<string, unknown> } | { ok: false; error: string } {
  const input: Record<string, unknown> = {};
  for (const f of info.fields) {
    const v = raw[f.key];
    const text = (firstFilled(v === undefined || v === null ? '' : readText(v).trim(), f.defaultValue) ?? '');
    if (text === '') {
      if (f.required === true) return { ok: false, error: `${f.label} is required.` };
      continue;
    }
    if (f.maxLength !== null && f.maxLength !== undefined && f.maxLength !== 0 && text.length > f.maxLength) return { ok: false, error: `${f.label} can be at most ${f.maxLength} characters.` };
    if (f.minLength !== null && f.minLength !== undefined && f.minLength !== 0 && text.length < f.minLength) return { ok: false, error: `${f.label} needs at least ${f.minLength} characters.` };
    if (has(f.pattern) && !new RegExp(f.pattern).test(text)) return { ok: false, error: `${f.label} must be ${f.patternHint ?? 'in the right form'}.` };
    if (f.type === 'number') {
      const n = Number(text);
      if (!Number.isFinite(n)) return { ok: false, error: `${f.label} must be a number.` };
      if (!/^\d+(\.\d{1,2})?$/.test(text)) return { ok: false, error: `${f.label} can have at most 2 decimal places.` };
      if (f.whole === true && !/^\d+$/.test(text)) return { ok: false, error: `${f.label} must be a whole number of shillings.` };
      if (f.min !== undefined && n < f.min) return { ok: false, error: `${f.label} must be at least ${f.min}.` };
      if (f.max !== undefined && n > f.max) return { ok: false, error: `${f.label} must be at most ${f.max}.` };
      input[f.key] = text;
      continue;
    }
    if (f.type === 'select' && f.options && !f.options.some(([value]) => value === text)) return { ok: false, error: `${f.label}: choose one of the options.` };
    if (f.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(text)) return { ok: false, error: `${f.label} must be a date.` };
    input[f.key] = text;
  }
  // Fields the screen did not declare are never passed on.
  return { ok: true, input };
}
