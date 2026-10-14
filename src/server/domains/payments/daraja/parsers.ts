import type { InboundClaim } from '../engine/types';
import { maskPhone, phoneFingerprint } from '../engine/redact';
import { toCentsLoose } from './security';

/** A payer number becomes a fingerprint and a masked form; one that Safaricom already masked has no fingerprint. */
function payer(raw: string | null): { payerFingerprint: string | null; payerMasked: string | null } {
  if (!raw) return { payerFingerprint: null, payerMasked: null };
  if (/[*•x]/i.test(raw) || raw.replace(/\D/g, '').length < 9) return { payerFingerprint: null, payerMasked: raw.slice(0, 16) };
  return { payerFingerprint: phoneFingerprint(raw), payerMasked: maskPhone(raw) };
}

/**
 * Reading what Safaricom sends. Every function here is tolerant of what is missing and never
 * throws: the result says what the payload claims, and whether it could be read at all.
 */
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : null);

function emptyClaim(kind: string): InboundClaim {
  return { kind, claimsSuccess: null, platformReference: null, conversationId: null, originatorId: null, requestIds: {}, amountCents: null, currency: 'KES', payerFingerprint: null, payerMasked: null, shortcode: null, accountReference: null, occurredAt: null, failureCode: null, failureReason: null, extra: {} };
}

/** "20240131124530" -> Date in East Africa Time. */
export function parseDarajaTime(v: unknown): Date | null {
  const t = str(v);
  if (!t || !/^\d{14}$/.test(t)) return null;
  const d = new Date(`${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}+03:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The ResultParameter list as a name -> value map (values kept as sent). */
export function resultParameters(result: Record<string, unknown>): Record<string, string> {
  const params = rec(result.ResultParameters);
  const list = params.ResultParameter;
  const items = Array.isArray(list) ? list : list ? [list] : [];
  const out: Record<string, string> = {};
  for (const item of items) {
    const r = rec(item);
    const k = str(r.Key);
    if (k) out[k] = r.Value === undefined || r.Value === null ? '' : typeof r.Value === 'object' ? JSON.stringify(r.Value) : String(r.Value);
  }
  return out;
}

export function referenceItems(result: Record<string, unknown>): Record<string, string> {
  const ref = rec(result.ReferenceData);
  const item = ref.ReferenceItem;
  const items = Array.isArray(item) ? item : item ? [item] : [];
  const out: Record<string, string> = {};
  for (const it of items) {
    const r = rec(it);
    const k = str(r.Key);
    if (k) out[k] = r.Value === undefined || r.Value === null ? '' : String(r.Value);
  }
  return out;
}

/** M-Pesa Express (STK Push) callback. */
export function parseStkCallback(body: unknown): InboundClaim | null {
  const cb = rec(rec(rec(body).Body).stkCallback);
  if (Object.keys(cb).length === 0) return null;
  const claim = emptyClaim('stk_callback');
  const code = str(cb.ResultCode);
  claim.claimsSuccess = code === null ? null : code === '0';
  claim.requestIds = { checkoutRequestId: str(cb.CheckoutRequestID) ?? '', merchantRequestId: str(cb.MerchantRequestID) ?? '' };
  claim.conversationId = str(cb.CheckoutRequestID);
  claim.failureCode = code && code !== '0' ? code : null;
  claim.failureReason = code && code !== '0' ? (str(cb.ResultDesc) ?? `ResultCode ${code}`) : null;
  const meta = rec(cb.CallbackMetadata).Item;
  const items = Array.isArray(meta) ? meta : [];
  const get = (name: string) => {
    const hit = items.map(rec).find((i) => String(i.Name ?? '').toLowerCase() === name.toLowerCase());
    return hit ? hit.Value : undefined;
  };
  claim.platformReference = str(get('MpesaReceiptNumber'));
  claim.amountCents = toCentsLoose(get('Amount'));
  Object.assign(claim, payer(str(get('PhoneNumber'))));
  claim.occurredAt = parseDarajaTime(get('TransactionDate'));
  claim.extra = { resultDesc: str(cb.ResultDesc) };
  return claim;
}

/** Customer-to-Business validation or confirmation. */
export function parseC2b(kind: 'c2b_validation' | 'c2b_confirmation', body: unknown): InboundClaim | null {
  const b = rec(body);
  if (!str(b.TransID) && !str(b.BusinessShortCode)) return null;
  const claim = emptyClaim(kind);
  claim.claimsSuccess = kind === 'c2b_confirmation' ? true : null;
  claim.platformReference = str(b.TransID);
  claim.amountCents = toCentsLoose(b.TransAmount);
  Object.assign(claim, payer(str(b.MSISDN)));
  claim.shortcode = str(b.BusinessShortCode);
  claim.accountReference = str(b.BillRefNumber);
  claim.occurredAt = parseDarajaTime(b.TransTime);
  claim.extra = {
    transactionType: str(b.TransactionType),
    orgAccountBalance: str(b.OrgAccountBalance),
    thirdPartyTransId: str(b.ThirdPartyTransID),
    name: [b.FirstName, b.MiddleName, b.LastName].map(str).filter(Boolean).join(' '),
  };
  return claim;
}

export interface AsyncResult {
  resultCode: string;
  resultDesc: string | null;
  originatorId: string | null;
  conversationId: string | null;
  transactionId: string | null;
  resultType: string | null;
  params: Record<string, string>;
  references: Record<string, string>;
}

/** The final answer to an asynchronous request (balance, status, reversal, B2C, B2B, tax). */
export function parseAsyncResult(body: unknown): AsyncResult | null {
  const r = rec(rec(body).Result);
  if (Object.keys(r).length === 0) return null;
  return {
    resultCode: str(r.ResultCode) ?? '',
    resultDesc: str(r.ResultDesc),
    originatorId: str(r.OriginatorConversationID),
    conversationId: str(r.ConversationID),
    transactionId: str(r.TransactionID),
    resultType: str(r.ResultType),
    params: resultParameters(r),
    references: referenceItems(r),
  };
}

/** The M-Pesa receipt out of an async result's parameters (it is named differently by operation). */
export function receiptFromParams(p: Record<string, string>): string | null {
  return p.ReceiptNo || p.TransactionReceipt || p.TransactionID || null;
}

/** B2B Express Checkout's callback is flat, not wrapped in "Result". */
export function parseB2bExpress(body: unknown): InboundClaim | null {
  const b = rec(body);
  if (!str(b.requestId) && !str(b.resultCode)) return null;
  const claim = emptyClaim('b2b_express_callback');
  const code = str(b.resultCode);
  claim.claimsSuccess = code === null ? null : code === '0' && String(b.status ?? 'SUCCESS').toUpperCase() !== 'FAILED';
  claim.originatorId = str(b.requestId);
  claim.conversationId = str(b.conversationID);
  claim.platformReference = str(b.transactionId);
  claim.amountCents = toCentsLoose(b.amount);
  claim.failureCode = code && code !== '0' ? code : null;
  claim.failureReason = str(b.resultDesc);
  claim.accountReference = str(b.paymentReference);
  return claim;
}

/** Bill Manager tells us a customer paid an invoice. */
export function parseBillPayment(body: unknown): InboundClaim | null {
  const b = rec(body);
  if (!str(b.transactionId)) return null;
  const claim = emptyClaim('bill_payment');
  claim.claimsSuccess = true;
  claim.platformReference = str(b.transactionId);
  claim.amountCents = toCentsLoose(b.paidAmount);
  Object.assign(claim, payer(str(b.msisdn)));
  claim.shortcode = str(b.shortCode);
  claim.accountReference = str(b.accountReference);
  claim.occurredAt = b.dateCreated ? new Date(String(b.dateCreated)) : null;
  return claim;
}

/** The balance string: "Working Account|KES|700000.00|700000.00|0.00|0.00&Utility Account|KES|…". */
export function parseAccountBalance(value: string): { account: string; currency: string; available: string; uncleared: string; reserved: string }[] {
  return value
    .split('&')
    .map((part) => part.split('|'))
    .filter((f) => f.length >= 3)
    .map((f) => ({ account: f[0].trim(), currency: f[1].trim(), available: (f[2] ?? '').trim(), uncleared: (f[3] ?? '').trim(), reserved: (f[4] ?? '').trim() }));
}
