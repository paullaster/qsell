import { constants, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { delayForAge, engineSettings } from '../engine/settings';
import { bodyHash, ipAllowed, maskPhone, newSecret, phoneFingerprint, redactDeep, redactHeaders, redactUrl } from '../engine/redact';
import { darajaFailure } from './client';
import { darajaSettings } from './config';
import { acceptance } from './operations';
import { parseAccountBalance, parseAsyncResult, parseB2bExpress, parseBillPayment, parseC2b, parseDarajaTime, parseStkCallback } from './parsers';
import { darajaTimestamp, looksLikeReceipt, securityCredential, stkPassword, toCentsLoose, toMsisdn } from './security';
import { pullRecords } from './c2b';
import { crossCheckClaim, readStatusAnswer, statusAgrees } from './verify';
import type { VerifyAttemptInput } from '../engine/types';
import { required } from '@/lib/values';

describe('what may be logged', () => {
  it('hides secrets and masks phone numbers, wherever they sit', () => {
    const out = redactDeep({
      SecurityCredential: 'abc',
      Password: 'p',
      Initiator: 'api',
      PartyA: '254712345678',
      body: { Body: { stkCallback: { CallbackMetadata: { Item: [{ Name: 'PhoneNumber', Value: 254712345678 }, { Name: 'Amount', Value: 10 }] } } } },
      nested: [{ consumerSecret: 'x', MSISDN: '254712345678' }],
    });
    expect(out.SecurityCredential).toBe('[REDACTED]');
    expect(out.Password).toBe('[REDACTED]');
    expect(out.Initiator).toBe('api');
    expect(out.PartyA).toBe('2547•••••678');
    expect(out.body.Body.stkCallback.CallbackMetadata.Item).toEqual([{ Name: 'PhoneNumber', Value: '2547•••••678' }, { Name: 'Amount', Value: 10 }]);
    expect(out.nested[0]).toEqual({ consumerSecret: '[REDACTED]', MSISDN: '2547•••••678' });
    expect(JSON.stringify(out)).not.toContain('254712345678');
  });
  it('hides the secret in a callback address even inside a logged body', () => {
    const out = redactDeep({ ConfirmationURL: 'https://x.test/api/hooks/pay/abc/c2b-confirm/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789' });
    expect(out.ConfirmationURL).toBe('https://x.test/api/hooks/pay/abc/c2b-confirm/[secret]');
  });
  it('hides authorization headers and the secret in a callback address', () => {
    expect(redactHeaders({ Authorization: 'Bearer x', 'content-type': 'a' })).toEqual({ Authorization: '[REDACTED]', 'content-type': 'a' });
    expect(redactUrl('https://x.test/api/hooks/pay/abc/c2b-confirm/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789')).toBe('https://x.test/api/hooks/pay/abc/c2b-confirm/[secret]');
    expect(redactUrl('https://x.test/a?token=zzz&b=1')).toBe('https://x.test/a?token=[REDACTED]&b=1');
  });
  it('fingerprints a phone number the same however it is written, and never as the number', () => {
    expect(phoneFingerprint('0712345678')).toBe(phoneFingerprint('+254 712 345 678'));
    expect(phoneFingerprint('0712345678')).not.toBe(phoneFingerprint('0712345679'));
    expect(phoneFingerprint('0712345678')).not.toContain('712345678');
    expect(maskPhone('254712345678')).toBe('2547•••••678');
  });
  it('makes unguessable secrets that avoid the words Safaricom refuses in an address', () => {
    for (let i = 0; i < 300; i++) expect(newSecret()).not.toMatch(/(m-?pesa|safaricom|exe|exec|cmd|sql|query)/i);
    expect(new Set(Array.from({ length: 50 }, newSecret)).size).toBe(50);
  });
  it('allows callbacks only from the addresses it is told, and everyone when told nothing', () => {
    expect(ipAllowed('1.2.3.4', [])).toBe(true);
    expect(ipAllowed('196.201.214.200', ['196.201.214.0/24'])).toBe(true);
    expect(ipAllowed('196.201.215.1', ['196.201.214.0/24'])).toBe(false);
    expect(ipAllowed('10.0.0.5', ['10.0.0.5'])).toBe(true);
    expect(ipAllowed('::ffff:196.201.214.9', ['196.201.214.0/24'])).toBe(true);
    expect(ipAllowed(null, ['1.2.3.4'])).toBe(false);
    expect(ipAllowed('2001:db8::1', ['196.201.214.0/24'])).toBe(false);
    expect(bodyHash('a')).toHaveLength(64);
  });
});

describe('signing requests', () => {
  it('builds the STK password and an East Africa Time timestamp', () => {
    expect(darajaTimestamp(new Date('2026-10-13T21:05:09Z'))).toBe('20261014000509'); // 00:05:09 the next day in Nairobi
    expect(darajaTimestamp(new Date('2026-01-01T09:00:00Z'))).toBe('20260101120000');
    expect(Buffer.from(stkPassword('174379', 'pass', '20260101120000'), 'base64').toString()).toBe('174379pass20260101120000');
  });
  it('seals the initiator password with RSA PKCS#1 v1.5 so only the holder of the key can read it', () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const sealed = securityCredential('Initiator#Pass1', pem);
    const opened = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(sealed, 'base64')).toString();
    expect(opened).toBe('Initiator#Pass1');
    expect(() => securityCredential('x', 'not a certificate')).toThrow(/certificate could not be read/);
  });
  it('turns Kenyan numbers into one form and refuses what is not one', () => {
    expect(toMsisdn('0712345678')).toBe('254712345678');
    expect(toMsisdn('+254 712 345 678')).toBe('254712345678');
    expect(toMsisdn('712345678')).toBe('254712345678');
    expect(toMsisdn('0112345678')).toBe('254112345678');
    expect(toMsisdn('12345')).toBeNull();
    expect(toMsisdn(null)).toBeNull();
  });
  it('reads amounts as exact cents and receipts by their shape', () => {
    expect(toCentsLoose('71.0')).toBe(7100);
    expect(toCentsLoose(71)).toBe(7100);
    expect(toCentsLoose('1,000.50')).toBe(100050);
    expect(toCentsLoose('1.005')).toBeNull();
    expect(toCentsLoose('abc')).toBeNull();
    expect(looksLikeReceipt('NLJ7RT61SV')).toBe(true);
    expect(looksLikeReceipt('nlj7rt61sv')).toBe(false);
    expect(looksLikeReceipt('SHORT')).toBe(false);
  });
});

const stk = (code: number | string, extra: Record<string, unknown> = {}) => ({
  Body: { stkCallback: { MerchantRequestID: 'M-1', CheckoutRequestID: 'ws_CO_1', ResultCode: code, ResultDesc: 'desc', ...extra } },
});
const meta = (amount: number, phone: number | string, receipt = 'NLJ7RT61SV') => ({
  CallbackMetadata: { Item: [{ Name: 'Amount', Value: amount }, { Name: 'MpesaReceiptNumber', Value: receipt }, { Name: 'TransactionDate', Value: 20260113123045 }, { Name: 'PhoneNumber', Value: phone }] },
});

describe('reading what Safaricom sends', () => {
  it('reads a successful STK callback, keeping the payer only as a fingerprint', () => {
    const c = required(parseStkCallback(stk(0, meta(100, 254712345678))));
    expect(c).toMatchObject({ kind: 'stk_callback', claimsSuccess: true, platformReference: 'NLJ7RT61SV', amountCents: 10000, requestIds: { checkoutRequestId: 'ws_CO_1', merchantRequestId: 'M-1' } });
    expect(c.payerFingerprint).toBe(phoneFingerprint('0712345678'));
    expect(JSON.stringify(c)).not.toContain('254712345678');
    expect(c.occurredAt?.toISOString()).toBe('2026-01-13T09:30:45.000Z');
  });
  it('reads a failed STK callback and one it cannot read', () => {
    expect(parseStkCallback(stk(1032))).toMatchObject({ claimsSuccess: false, failureCode: '1032', failureReason: 'desc' });
    expect(parseStkCallback({ nope: 1 })).toBeNull();
    expect(parseStkCallback(null)).toBeNull();
  });
  it('reads C2B payments and masked numbers', () => {
    const c = required(parseC2b('c2b_confirmation', { TransactionType: 'Pay Bill', TransID: 'RKTQDM7W6S', TransTime: '20260113123045', TransAmount: '10.00', BusinessShortCode: '600638', BillRefNumber: 'C0001', MSISDN: '2547 ***** 126', FirstName: 'Jane', LastName: 'Doe' }));
    expect(c).toMatchObject({ platformReference: 'RKTQDM7W6S', amountCents: 1000, shortcode: '600638', accountReference: 'C0001', claimsSuccess: true, payerFingerprint: null });
    expect(c.extra.name).toBe('Jane Doe');
    expect(parseC2b('c2b_validation', {})).toBeNull();
  });
  it('reads the final answer of an asynchronous request, and the receipt wherever it is named', () => {
    const r = required(parseAsyncResult({ Result: { ResultType: 0, ResultCode: 0, ResultDesc: 'ok', OriginatorConversationID: 'o', ConversationID: 'c', TransactionID: 'T1', ResultParameters: { ResultParameter: [{ Key: 'ReceiptNo', Value: 'MBN31H462N' }, { Key: 'Amount', Value: 300 }] }, ReferenceData: { ReferenceItem: { Key: 'QueueTimeoutURL', Value: 'u' } } } }));
    expect(r).toMatchObject({ resultCode: '0', originatorId: 'o', conversationId: 'c', transactionId: 'T1', params: { ReceiptNo: 'MBN31H462N', Amount: '300' }, references: { QueueTimeoutURL: 'u' } });
    expect(parseAsyncResult({})).toBeNull();
    expect(parseDarajaTime('20260113123045')?.toISOString()).toBe('2026-01-13T09:30:45.000Z');
    expect(parseDarajaTime('nope')).toBeNull();
  });
  it('reads Express Checkout and Bill Manager notifications and the balance string', () => {
    expect(parseB2bExpress({ resultCode: '0', requestId: 'r1', amount: '71.0', transactionId: 'RDQ01NFT1Q', status: 'SUCCESS' })).toMatchObject({ claimsSuccess: true, originatorId: 'r1', platformReference: 'RDQ01NFT1Q', amountCents: 7100 });
    expect(parseB2bExpress({ resultCode: '4001', requestId: 'r2', resultDesc: 'User cancelled transaction' })).toMatchObject({ claimsSuccess: false, failureCode: '4001' });
    expect(parseBillPayment({ transactionId: 'X1', paidAmount: '500', msisdn: '254712345678', accountReference: 'A1', shortCode: '600' })).toMatchObject({ platformReference: 'X1', amountCents: 50000, shortcode: '600' });
    expect(parseAccountBalance('Working Account|KES|700000.00|700000.00|0.00|0.00&Utility Account|KES|1500.50|1500.50|0.00|0.00')).toEqual([
      { account: 'Working Account', currency: 'KES', available: '700000.00', uncleared: '700000.00', reserved: '0.00' },
      { account: 'Utility Account', currency: 'KES', available: '1500.50', uncleared: '1500.50', reserved: '0.00' },
    ]);
  });
  it('finds the rows of a Pull Transactions answer wherever the answer puts them', () => {
    const rows = pullRecords({ ResponseCode: '1000', Response: [[{ transactionId: 'AAA1111111', trxDate: '2026-01-13T09:30:45Z', msisdn: 254712345678, billreference: 'C1', amount: 233.8, transactiontype: 'c2b-pay-bill-debit' }]] });
    expect(rows).toEqual([{ transactionId: 'AAA1111111', trxDate: '2026-01-13T09:30:45Z', msisdn: '254712345678', billReference: 'C1', amountCents: 23380, type: 'c2b-pay-bill-debit' }]);
    expect(pullRecords(null)).toEqual([]);
    expect(pullRecords({ Transaction: '[[]]' })).toEqual([]);
  });
});

describe('what Safaricom answered', () => {
  const res = (status: number, json: Record<string, unknown> | null, reached = true) => ({ reached, status, json, text: json ? JSON.stringify(json) : '', durationMs: 1, networkError: reached ? null : 'down', correlationId: 'c' });
  it('classifies failures: retry, duplicate, token refused', () => {
    expect(darajaFailure(res(200, { ResponseCode: '0' }))).toBeNull();
    expect(darajaFailure(res(0, null, false))).toMatchObject({ code: 'NO_RESPONSE', retryable: true });
    expect(darajaFailure(res(500, { errorCode: '500.003.02', errorMessage: 'Spike' }))).toMatchObject({ retryable: true });
    expect(darajaFailure(res(500, { errorCode: '500.002.1001', errorMessage: 'Duplicate OriginatorConversationID.' }))).toMatchObject({ duplicate: true });
    expect(darajaFailure(res(404, { errorCode: '404.001.03', errorMessage: 'Invalid Access Token' }))).toMatchObject({ tokenRejected: true, retryable: false });
    expect(darajaFailure(res(400, { errorCode: '400.002.02', errorMessage: 'Bad Request - Invalid Amount' }))).toMatchObject({ retryable: false, duplicate: false, tokenRejected: false });
  });
  it('decides acceptance per operation, in the shape each answers', () => {
    expect(acceptance('stk_push', { ResponseCode: '0' })).toEqual({ ok: true });
    expect(acceptance('stk_push', { ResponseCode: '1', ResponseDescription: 'No' })).toMatchObject({ ok: false, code: '1', reason: 'No' });
    expect(acceptance('pull_register', { ResponseStatus: '1001' })).toEqual({ ok: true });
    expect(acceptance('pull_register', { ResponseStatus: '400' })).toMatchObject({ ok: false });
    expect(acceptance('qr_generate', { ResponseCode: 'AG_2019', QRCode: 'iVBOR' })).toEqual({ ok: true });
    expect(acceptance('qr_generate', { ResponseCode: 'AG_2019' })).toMatchObject({ ok: false });
    expect(acceptance('pull_query', { ResponseCode: '1001' })).toEqual({ ok: true });
  });
});

const input = (over: Partial<VerifyAttemptInput> = {}): VerifyAttemptInput => ({
  attemptId: 'a1', orderNumber: 'ORD-1', amountCents: 10000, currency: 'KES', customerPhone: '0712345678', providerReference: 'ws_CO_1', externalReference: 'M-1', createdAt: new Date(), claim: null, mode: 'standard', evidence: [], ...over,
});

describe('a callback must agree with what we asked for', () => {
  const claim = (over = {}) => ({ ...required(parseStkCallback(stk(0, meta(100, 254712345678)))), ...over });
  it('passes when everything agrees, and when there is no callback yet', () => {
    expect(crossCheckClaim(input({ claim: claim() }))).toBeNull();
    expect(crossCheckClaim(input())).toBeNull();
  });
  it('refuses a callback about another checkout, another merchant request, another amount, another payer, or a made-up receipt', () => {
    expect(crossCheckClaim(input({ claim: claim({ requestIds: { checkoutRequestId: 'ws_CO_X', merchantRequestId: 'M-1' } }) }))?.code).toBe('CHECKOUT_ID_MISMATCH');
    expect(crossCheckClaim(input({ claim: claim({ requestIds: { checkoutRequestId: 'ws_CO_1', merchantRequestId: 'M-X' } }) }))?.code).toBe('MERCHANT_ID_MISMATCH');
    expect(crossCheckClaim(input({ claim: claim({ amountCents: 100 }) }))?.code).toBe('AMOUNT_MISMATCH');
    expect(crossCheckClaim(input({ customerPhone: '0799999999', claim: claim() }))?.code).toBe('PAYER_MISMATCH');
    expect(crossCheckClaim(input({ claim: claim({ platformReference: 'abc' }) }))?.code).toBe('RECEIPT_FORMAT');
  });
  it('does not hold a failed callback to the amount and payer rules', () => {
    const failed = required(parseStkCallback(stk(1032)));
    expect(crossCheckClaim(input({ claim: failed }))).toBeNull();
  });
});

describe("Safaricom's own record of a transaction", () => {
  const result = { resultCode: '0', resultDesc: 'ok', params: { ReceiptNo: 'NLJ7RT61SV', Amount: '100', TransactionStatus: 'Completed', CreditPartyName: '600638 - Acme Ltd' } };
  it('reads a status answer and checks it against the payment', () => {
    const answer = required(readStatusAnswer(result));
    expect(answer).toMatchObject({ ok: true, receipt: 'NLJ7RT61SV', amountCents: 10000, creditParty: '600638 - Acme Ltd' });
    expect(statusAgrees(answer, { receipt: 'NLJ7RT61SV', amountCents: 10000, shortcode: '600638' })).toEqual({ ok: true });
    expect(statusAgrees(answer, { receipt: 'OTHER00001', amountCents: 10000, shortcode: '600638' })).toMatchObject({ ok: false, code: 'STATUS_RECEIPT_MISMATCH' });
    expect(statusAgrees(answer, { receipt: 'NLJ7RT61SV', amountCents: 9999, shortcode: '600638' })).toMatchObject({ ok: false, code: 'STATUS_AMOUNT_MISMATCH' });
    expect(statusAgrees(answer, { receipt: 'NLJ7RT61SV', amountCents: 10000, shortcode: '999999' })).toMatchObject({ ok: false, code: 'STATUS_RECEIVER_MISMATCH' });
  });
  it('does not accept a status that is not completed', () => {
    const answer = required(readStatusAnswer({ ...result, params: { ...result.params, TransactionStatus: 'Cancelled' } }));
    expect(statusAgrees(answer, { receipt: null, amountCents: 10000, shortcode: null })).toMatchObject({ ok: false, code: 'STATUS_NOT_COMPLETED' });
    const failed = required(readStatusAnswer({ resultCode: '2001', resultDesc: 'The initiator information is invalid.', params: {} }));
    expect(failed.ok).toBe(false);
  });
});

describe('settings fall back to safe defaults', () => {
  it('money in is on, money out is off, and nonsense is ignored', () => {
    const s = darajaSettings({ verification: { mode: 'strict', pollSeconds: ['x', 1, 30], windowMinutes: 'a' }, c2b: { validation: 'bogus' }, operations: { b2c: { enabled: true, maxAmount: '5000' }, stk_push: { enabled: 'no' } } });
    expect(s.verification).toEqual({ mode: 'strict', pollSeconds: [30], windowMinutes: 120 });
    expect(s.c2b).toEqual({ responseType: 'Completed', validation: 'accept_all', autoAllocate: 'off', apiVersion: 'v2' });
    expect(s.operations.b2c).toEqual({ enabled: true, maxAmount: '5000' });
    expect(s.operations.stk_push.enabled).toBe(true);
    expect(s.operations.reversal.enabled).toBe(false);
    expect(s.operations.tax_remittance.enabled).toBe(false);
    expect(engineSettings(null).security.allowedCidrs).toEqual([]);
  });
  it('asks again on a schedule that depends only on how old the payment is', () => {
    const v = { mode: 'standard' as const, pollSeconds: [15, 45, 120], windowMinutes: 120 };
    expect(delayForAge(v, 0)).toBe(15);
    expect(delayForAge(v, 20)).toBe(45);
    expect(delayForAge(v, 70)).toBe(120);
    expect(delayForAge(v, 100000)).toBe(120);
  });
});
