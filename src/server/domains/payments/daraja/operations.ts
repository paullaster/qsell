import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { paymentMethods, paymentProviderConfigs, type PaymentMethodRow, type ProviderOperationRow } from '@/server/db/drizzle/schema';
import type { PlatformContexts } from '../engine/context';
import type { PaymentJobs } from '../engine/jobs';
import type { ProviderOperationService } from '../engine/operation-service';
import type { PlatformContext } from '../engine/types';
import { DarajaClient, darajaFailure } from './client';
import { DARAJA_OPERATIONS, type DarajaOperationCode } from './catalog';
import { darajaSettings, OPERATION_DEFAULTS } from './config';
import { parseAsyncResult, receiptFromParams, resultParameters } from './parsers';
import { darajaTimestamp, looksLikeReceipt, securityCredential, stkPassword, toMsisdn } from './security';

import { has } from '@/lib/has';

export { DARAJA_OPERATIONS, MONEY_OUT_OPERATIONS, validateOperationInput, type DarajaOperationCode, type OperationInfo, type FieldSpec } from './catalog';

export interface StartOperation {
  providerId: string;
  methodId?: string | null;
  operation: DarajaOperationCode;
  input: Record<string, unknown>;
  /** The same key twice is the same operation. Defaults to a fresh one. */
  idempotencyKey?: string;
  subject?: { type: string; id: string } | null;
  requestedBy?: string | null;
  origin?: Record<string, unknown>;
}

export class OperationRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}


/** Did Safaricom accept this request? Each operation answers in its own shape. */
export function acceptance(operation: DarajaOperationCode, body: Record<string, unknown>): { ok: true } | { ok: false; code: string; reason: string } {
  const text = (k: string) => (body[k] === undefined || body[k] === null ? '' : String(body[k]));
  const refused = (code: string, fallback: string) => ({ ok: false as const, code: code || 'REFUSED', reason: text('ResponseDescription') || text('errorMessage') || text('resmsg') || fallback });
  switch (operation) {
    case 'pull_register':
      return ['1000', '1001'].includes(text('ResponseStatus')) ? { ok: true } : refused(text('ResponseStatus'), 'The registration was refused.');
    case 'pull_query':
      // 1000 = transactions, 1001 = none in the period; both are answers.
      return !has(text('ResponseCode')) || ['0', '1000', '1001'].includes(text('ResponseCode')) ? { ok: true } : refused(text('ResponseCode'), 'The query was refused.');
    case 'b2b_express':
      return text('code') === '0' ? { ok: true } : refused(text('code'), text('status') || 'The prompt could not be sent.');
    case 'bill_optin':
    case 'bill_update_optin':
    case 'bill_invoice':
    case 'bill_invoice_bulk':
    case 'bill_cancel':
    case 'bill_cancel_bulk':
    case 'bill_acknowledge':
      return text('rescode') === '200' ? { ok: true } : { ok: false, code: text('rescode') || 'REFUSED', reason: text('resmsg') || text('Status_Message') || 'Bill Manager did not accept the request.' };
    case 'qr_generate':
      return has(text('QRCode')) ? { ok: true } : refused(text('ResponseCode'), 'No QR code came back.');
    default:
      return text('ResponseCode') === '0' ? { ok: true } : refused(text('ResponseCode'), 'Safaricom did not accept the request.');
  }
}

const RESEND_SECONDS = [10, 30, 90, 300, 900];
const ASYNC_WAIT_SECONDS = 600;

/** The addresses Safaricom calls us on. The secret is the provider's; the words in the path avoid what Safaricom refuses. */
export function callbackUrl(ctx: PlatformContext, secret: string, kind: 'c2b-confirm' | 'c2b-validate' | 'result' | 'timeout' | 'express' | 'bill' | 'pull'): string {
  if (!has(ctx.publicBaseUrl)) throw new OperationRefused('NO_PUBLIC_URL', "Set the company's public address first (Settings → Payments); Safaricom needs it to call back.");
  return `${ctx.publicBaseUrl}/api/hooks/pay/${ctx.provider.id}/${kind}/${secret}`;
}

/**
 * Runs Daraja operations: checks they are allowed, writes them down before sending, sends them with
 * the same id however many times it takes, and finishes them from the platform's answer. Whatever
 * happens, the operation row says where it stands and why.
 */
export class DarajaOperations {
  constructor(
    private readonly db: DrizzleDb,
    private readonly ops: ProviderOperationService,
    private readonly contexts: PlatformContexts,
    private readonly jobs: PaymentJobs,
  ) {}

  private async method(id: string | null | undefined): Promise<PaymentMethodRow | null> {
    if (!has(id)) return null;
    const [m] = await this.db.select().from(paymentMethods).where(eq(paymentMethods.id, id));
    return m ?? null;
  }

  /** Checks that the operation may run, writes it down, and sends it. Returns the row as it stands after the first send. */
  async start(input: StartOperation): Promise<{ op: ProviderOperationRow; created: boolean }> {
    const info = DARAJA_OPERATIONS[input.operation];
    if (!info) throw new OperationRefused('UNKNOWN_OPERATION', `"${input.operation}" is not something this provider can do.`);
    const ctx = await this.contexts.forProvider(input.providerId);
    if (ctx.provider.providerCode !== 'mpesa_daraja') throw new OperationRefused('WRONG_PROVIDER', 'That provider is not an M-Pesa (Daraja) connection.');
    const settings = darajaSettings(ctx.settings);
    if ((settings.operations[input.operation]?.enabled ?? OPERATION_DEFAULTS[input.operation]) !== true) {
      throw new OperationRefused('OPERATION_OFF', `${info.label} is switched off for this provider (Settings → Payments).`);
    }
    if (info.sandboxOnly === true && ctx.provider.environment === 'production') throw new OperationRefused('SANDBOX_ONLY', `${info.label} only exists on Safaricom's testing environment.`);
    const amount = typeof input.input.amount === 'string' || typeof input.input.amount === 'number' ? String(input.input.amount) : null;
    const max = settings.operations[input.operation]?.maxAmount;
    if (has(amount) && has(max) && Number(amount) > Number(max)) throw new OperationRefused('OVER_LIMIT', `${info.label} is limited to ${max} per request for this provider.`);
    if (info.moneyOut) throw new OperationRefused('USE_REQUEST', `${info.label} moves money out, so it is requested and approved first, not run directly.`);
    if (info.needsInitiator) this.initiator(ctx); // refuse now, in words, not after it is written down
    const method = await this.method(input.methodId);
    if (has(input.methodId) && (!method || method.providerId !== input.providerId)) throw new OperationRefused('METHOD_MISMATCH', 'That payment method does not go through this provider.');

    const originatorId = randomUUID();
    const { op, created } = await this.ops.create({
      companyId: ctx.companyId,
      providerId: input.providerId,
      methodId: input.methodId ?? null,
      operation: input.operation,
      idempotencyKey: input.idempotencyKey ?? `${input.operation}:${randomUUID()}`,
      originatorId,
      subjectType: input.subject?.type ?? null,
      subjectId: input.subject?.id ?? null,
      amount,
      currency: 'KES',
      input: input.input,
      requestedBy: input.requestedBy ?? null,
      origin: input.origin ?? {},
      status: 'queued',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    if (!created) return { op, created: false };
    await this.send(op.id);
    return { op: (await this.ops.get(op.id)), created: true };
  }

  private initiator(ctx: PlatformContext) {
    const c = ctx.credentials;
    if (!has(c.initiatorName?.trim()) || !has(c.initiatorPassword) || !has(c.certificate?.trim())) {
      throw new OperationRefused('NO_INITIATOR', "This needs the M-Pesa API operator's name and password and Safaricom's certificate. Save them on the provider (Settings → Payments).");
    }
    return { name: c.initiatorName.trim(), credential: securityCredential(c.initiatorPassword, c.certificate) };
  }

  /** Builds and sends one operation. Safe to call again for the same operation: it sends the same originator id. */
  async send(opId: string): Promise<void> {
    const op = await this.ops.get(opId);
    if (!op || !['queued', 'submitted'].includes(op.status)) return;
    const ctx = await this.contexts.forProvider(op.providerId);
    const client = new DarajaClient(ctx);
    const settings = darajaSettings(ctx.settings);
    const method = await this.method(op.methodId);
    await this.ops.bumpAttempts(op.id);
    let built: { path: string; body: unknown; method?: 'GET' | 'POST' };
    try {
      built = await this.build(op, ctx, settings, method);
    } catch (error) {
      const code = error instanceof OperationRefused ? error.code : 'BUILD_FAILED';
      await this.ops.update(op.id, { status: 'failed', failureCode: code, failureReason: error instanceof Error ? error.message : 'The request could not be built.' });
      return;
    }
    await this.ops.update(op.id, { status: 'submitted', request: (built.body ?? {}) as Record<string, unknown> });
    const res = await client.request(op.operation, built.method ?? 'POST', built.path, built.body, { operationId: op.id });
    const failure = darajaFailure(res);
    const info = DARAJA_OPERATIONS[op.operation as DarajaOperationCode];
    if (failure) {
      // Safaricom already has this exact request: it is as good as accepted, and its answer will come.
      if (failure.duplicate) {
        await this.ops.update(op.id, { status: 'accepted', response: res.json ?? {}, nextAttemptAt: new Date(Date.now() + ASYNC_WAIT_SECONDS * 1000) });
        return;
      }
      const fresh = (await this.ops.get(op.id));
      // Sending a customer prompt twice would ask them to pay twice, and we cannot tell whether an unanswered one arrived.
      // Only B2C is de-duplicated by Safaricom (on the originator id). Any other payout sent twice could pay twice.
      const unsafeToRepeat = op.operation === 'stk_push' || ((info?.moneyOut) && op.operation !== 'b2c');
      if (failure.retryable && !unsafeToRepeat && fresh.attempts < RESEND_SECONDS.length + 1) {
        const wait = RESEND_SECONDS[Math.min(fresh.attempts - 1, RESEND_SECONDS.length - 1)];
        await this.ops.update(op.id, { status: 'queued', failureCode: failure.code, failureReason: failure.message, response: res.json ?? {}, nextAttemptAt: new Date(Date.now() + wait * 1000) });
        await this.jobs.sendOperation(op.id, wait);
        return;
      }
      await this.ops.update(op.id, { status: 'failed', failureCode: failure.code, failureReason: failure.message, response: res.json ?? {} });
      return;
    }
    const body = res.json ?? {};
    const verdict = acceptance(op.operation as DarajaOperationCode, body);
    if (!verdict.ok) {
      await this.ops.update(op.id, { status: 'failed', failureCode: verdict.code, failureReason: verdict.reason, response: body });
      return;
    }
    if (info.async) {
      await this.ops.update(op.id, {
        status: 'accepted',
        response: body,
        conversationId: String(body.ConversationID ?? body.CheckoutRequestID ?? '') || null,
        nextAttemptAt: new Date(Date.now() + ASYNC_WAIT_SECONDS * 1000),
        failureCode: null,
        failureReason: null,
      });
      return;
    }
    await this.finishSync(op, body, ctx);
  }

  /** What each synchronous operation does with a good answer. */
  private async finishSync(op: ProviderOperationRow, body: Record<string, unknown>, ctx: PlatformContext) {
    const result: Record<string, unknown> = { ...body };
    if (op.operation === 'pull_register') {
      const code = String(body.ResponseStatus ?? body.ResponseCode ?? '');
      if (code === '1000' || code === '1001') {
        const settings = { ...(ctx.settings ?? {}), pull: { ...((ctx.settings?.pull as Record<string, unknown>) ?? {}), registered: true, nominatedNumber: String((op.input).nominatedNumber ?? '') } };
        await this.db.update(paymentProviderConfigs).set({ settings, updatedAt: new Date() }).where(eq(paymentProviderConfigs.id, op.providerId));
      } else {
        await this.ops.update(op.id, { status: 'failed', failureCode: code || 'REGISTER_FAILED', failureReason: String(body.ResponseDescription ?? 'Registration was refused.'), response: body });
        return;
      }
    }
    if (op.operation === 'c2b_register_urls' && String(body.ResponseCode ?? '0') !== '0') {
      await this.ops.update(op.id, { status: 'failed', failureCode: String(body.ResponseCode), failureReason: String(body.ResponseDescription ?? 'Registration was refused.'), response: body });
      return;
    }
    await this.ops.update(op.id, { status: 'succeeded', response: body, result, platformReference: null, failureCode: null, failureReason: null });
  }

  /** Builds the request for one operation from its stored input. Secrets are made here and never stored. */
  private async build(op: ProviderOperationRow, ctx: PlatformContext, settings: ReturnType<typeof darajaSettings>, method: PaymentMethodRow | null): Promise<{ path: string; body: unknown; method?: 'GET' | 'POST' }> {
    const input = op.input;
    const creds = ctx.credentials;
    const now = ctx.now();
    const shortcode = String(input.shortcode ?? method?.channelNumber ?? creds.shortcode ?? '').trim();
    switch (op.operation as DarajaOperationCode) {
      case 'stk_push': {
        if (!has(creds.shortcode?.trim()) || !has(creds.passkey?.trim())) throw new OperationRefused('NO_CREDENTIALS', 'M-Pesa Express needs the business shortcode and passkey.');
        const phone = toMsisdn(String(input.phone ?? ''));
        if (!has(phone)) throw new OperationRefused('PHONE_INVALID', 'The phone number is not a Kenyan mobile number.');
        const ts = darajaTimestamp(now);
        const amount = Math.max(1, Math.round(Number(input.amount)));
        return {
          path: '/mpesa/stkpush/v1/processrequest',
          body: {
            BusinessShortCode: creds.shortcode.trim(),
            Password: stkPassword(creds.shortcode.trim(), creds.passkey.trim(), ts),
            Timestamp: ts,
            TransactionType: creds.transactionType || 'CustomerPayBillOnline',
            Amount: amount,
            PartyA: phone,
            // A till payment names the till (PartyB); a paybill payment names the paybill.
            PartyB: String(input.partyB ?? method?.channelNumber ?? creds.shortcode).trim(),
            PhoneNumber: phone,
            CallBackURL: String(input.callbackUrl),
            AccountReference: String(input.accountReference ?? '').slice(0, 12),
            TransactionDesc: String(input.description ?? 'Payment').slice(0, 13),
          },
        };
      }
      case 'stk_query': {
        if (!has(creds.shortcode?.trim()) || !has(creds.passkey?.trim())) throw new OperationRefused('NO_CREDENTIALS', 'Checking an STK Push needs the business shortcode and passkey.');
        const ts = darajaTimestamp(now);
        return {
          path: '/mpesa/stkpushquery/v1/query',
          body: { BusinessShortCode: creds.shortcode.trim(), Password: stkPassword(creds.shortcode.trim(), creds.passkey.trim(), ts), Timestamp: ts, CheckoutRequestID: String(input.checkoutRequestId) },
        };
      }
      case 'c2b_register_urls': {
        if (!has(shortcode)) throw new OperationRefused('NO_SHORTCODE', 'Choose the paybill or till to register.');
        const secret = await this.contexts.callbackSecret(ctx.provider.id);
        return {
          path: `/mpesa/c2b/${settings.c2b.apiVersion}/registerurl`,
          body: {
            ShortCode: shortcode,
            ResponseType: String(input.responseType ?? settings.c2b.responseType),
            ConfirmationURL: callbackUrl(ctx, secret, 'c2b-confirm'),
            ValidationURL: callbackUrl(ctx, secret, 'c2b-validate'),
          },
        };
      }
      case 'c2b_simulate':
        return {
          path: `/mpesa/c2b/${settings.c2b.apiVersion}/simulate`,
          body: { ShortCode: Number(shortcode), CommandID: String(input.commandId ?? 'CustomerPayBillOnline'), Amount: Number(input.amount), Msisdn: Number(toMsisdn(String(input.phone ?? '254708374149'))), BillRefNumber: input.billRef ?? null },
        };
      case 'transaction_status': {
        const init = this.initiator(ctx);
        const secret = await this.contexts.callbackSecret(ctx.provider.id);
        if (!input.transactionId && !input.originalConversationId) throw new OperationRefused('NO_TRANSACTION', 'Give the M-Pesa code (or the original conversation id) to check.');
        return {
          path: '/mpesa/transactionstatus/v1/query',
          body: {
            Initiator: init.name,
            SecurityCredential: init.credential,
            CommandID: 'TransactionStatusQuery',
            ...(input.transactionId ? { TransactionID: String(input.transactionId) } : {}),
            ...(input.originalConversationId ? { OriginalConversationID: String(input.originalConversationId) } : {}),
            PartyA: shortcode,
            IdentifierType: '4',
            ResultURL: callbackUrl(ctx, secret, 'result'),
            QueueTimeOutURL: callbackUrl(ctx, secret, 'timeout'),
            Remarks: String(input.remarks ?? 'Status check').slice(0, 100),
            Occasion: String(input.occasion ?? 'check').slice(0, 100),
          },
        };
      }
      case 'pull_register': {
        const secret = await this.contexts.callbackSecret(ctx.provider.id);
        const nominated = String(input.nominatedNumber ?? settings.pull.nominatedNumber ?? '').trim();
        if (!has(shortcode) || !has(nominated)) throw new OperationRefused('PULL_INPUT', 'Registering for Pull Transactions needs the shortcode and the nominated phone number on the M-Pesa portal.');
        return { path: '/pulltransactions/v1/register', body: { ShortCode: shortcode, RequestType: 'Pull', NominatedNumber: nominated, CallBackURL: callbackUrl(ctx, secret, 'pull') } };
      }
      case 'pull_query':
        return { path: '/pulltransactions/v1/query', body: { ShortCode: shortcode, StartDate: String(input.startDate), EndDate: String(input.endDate), OffSetValue: String(input.offset ?? 0) } };
      case 'qr_generate':
        return {
          path: '/mpesa/qrcode/v1/generate',
          body: { MerchantName: String(input.merchantName).slice(0, 26), RefNo: String(input.refNo).slice(0, 12), Amount: Number(input.amount), TrxCode: String(input.trxCode ?? 'BG'), CPI: String(input.cpi ?? shortcode), Size: String(input.size ?? '300') },
        };
      case 'account_balance': {
        const init = this.initiator(ctx);
        const secret = await this.contexts.callbackSecret(ctx.provider.id);
        return { path: '/mpesa/accountbalance/v1/query', body: { Initiator: init.name, SecurityCredential: init.credential, CommandID: 'AccountBalance', PartyA: shortcode, IdentifierType: '4', Remarks: 'Balance check', QueueTimeOutURL: callbackUrl(ctx, secret, 'timeout'), ResultURL: callbackUrl(ctx, secret, 'result') } };
      }
      case 'reversal': {
        const init = this.initiator(ctx);
        const secret = await this.contexts.callbackSecret(ctx.provider.id);
        return { path: '/mpesa/reversal/v1/request', body: { Initiator: init.name, SecurityCredential: init.credential, CommandID: 'TransactionReversal', TransactionID: String(input.transactionId), Amount: String(input.amount), ReceiverParty: shortcode, RecieverIdentifierType: '11', ResultURL: callbackUrl(ctx, secret, 'result'), QueueTimeOutURL: callbackUrl(ctx, secret, 'timeout'), Remarks: String(input.remarks ?? 'Reversal').slice(0, 100), Occasion: String(input.occasion ?? 'reversal').slice(0, 100) } };
      }
      case 'b2c': {
        const init = this.initiator(ctx);
        const secret = await this.contexts.callbackSecret(ctx.provider.id);
        const phone = toMsisdn(String(input.phone ?? ''));
        if (!has(phone)) throw new OperationRefused('PHONE_INVALID', 'The phone number is not a Kenyan mobile number.');
        return {
          path: '/mpesa/b2c/v3/paymentrequest',
          body: { OriginatorConversationID: op.originatorId, InitiatorName: init.name, SecurityCredential: init.credential, CommandID: String(input.commandId ?? 'BusinessPayment'), Amount: String(input.amount), PartyA: shortcode, PartyB: phone, Remarks: String(input.remarks ?? 'Payment').slice(0, 100), QueueTimeOutURL: callbackUrl(ctx, secret, 'timeout'), ResultURL: callbackUrl(ctx, secret, 'result'), Occassion: String(input.occasion ?? '').slice(0, 100) },
        };
      }
      case 'b2b_paybill':
      case 'b2b_buygoods': {
        const init = this.initiator(ctx);
        const secret = await this.contexts.callbackSecret(ctx.provider.id);
        return {
          path: '/mpesa/b2b/v1/paymentrequest',
          body: {
            Initiator: init.name,
            SecurityCredential: init.credential,
            CommandID: op.operation === 'b2b_paybill' ? 'BusinessPayBill' : 'BusinessBuyGoods',
            SenderIdentifierType: '4',
            RecieverIdentifierType: '4',
            Amount: String(input.amount),
            PartyA: shortcode,
            PartyB: String(input.partyB),
            AccountReference: String(input.accountReference ?? '').slice(0, 13),
            ...(input.requester ? { Requester: toMsisdn(String(input.requester)) ?? undefined } : {}),
            Remarks: String(input.remarks ?? 'Payment').slice(0, 100),
            QueueTimeOutURL: callbackUrl(ctx, secret, 'timeout'),
            ResultURL: callbackUrl(ctx, secret, 'result'),
          },
        };
      }
      case 'tax_remittance': {
        const init = this.initiator(ctx);
        const secret = await this.contexts.callbackSecret(ctx.provider.id);
        return {
          path: '/mpesa/b2b/v1/remittax',
          body: { Initiator: init.name, SecurityCredential: init.credential, CommandID: 'PayTaxToKRA', SenderIdentifierType: '4', RecieverIdentifierType: '4', Amount: String(input.amount), PartyA: shortcode, PartyB: '572572', AccountReference: String(input.prn), Remarks: String(input.remarks ?? 'Tax').slice(0, 100), QueueTimeOutURL: callbackUrl(ctx, secret, 'timeout'), ResultURL: callbackUrl(ctx, secret, 'result') },
        };
      }
      case 'b2b_express': {
        const secret = await this.contexts.callbackSecret(ctx.provider.id);
        if (!has(shortcode)) throw new OperationRefused('NO_SHORTCODE', 'Choose the paybill that is to be paid.');
        return { path: '/v1/ussdpush/get-msisdn', body: { primaryShortCode: String(input.primaryShortCode), receiverShortCode: shortcode, amount: String(input.amount), paymentRef: String(input.paymentRef).slice(0, 20), callbackUrl: callbackUrl(ctx, secret, 'express'), partnerName: String(input.partnerName).slice(0, 40), RequestRefID: op.originatorId } };
      }
      case 'bill_optin':
      case 'bill_update_optin': {
        const secret = await this.contexts.callbackSecret(ctx.provider.id);
        return { path: op.operation === 'bill_optin' ? '/v1/billmanager-invoice/optin' : '/v1/billmanager-invoice/change-optin-details', body: { shortcode, email: String(input.email), officialContact: String(input.officialContact), sendReminders: String(input.sendReminders ?? '1'), callbackurl: callbackUrl(ctx, secret, 'bill') } };
      }
      case 'bill_invoice':
        return { path: '/v1/billmanager-invoice/single-invoicing', body: billInvoice(input) };
      case 'bill_invoice_bulk':
        return { path: '/v1/billmanager-invoice/bulk-invoicing', body: Array.isArray(input.invoices) ? input.invoices.map((i) => billInvoice(i as Record<string, unknown>)) : [] };
      case 'bill_cancel':
        return { path: '/v1/billmanager-invoice/cancel-single-invoice', body: { externalReference: String(input.externalReference) } };
      case 'bill_cancel_bulk':
        return { path: '/v1/billmanager-invoice/cancel-bulk-invoices', body: Array.isArray(input.references) ? input.references.map((externalReference) => ({ externalReference })) : [] };
      case 'bill_acknowledge':
        return { path: '/v1/billmanager-invoice/reconciliation', body: { paymentDate: String(input.paymentDate), paidAmount: String(input.paidAmount), accountReference: String(input.accountReference), transactionId: String(input.transactionId), phoneNumber: String(input.phoneNumber ?? ''), fullName: String(input.fullName ?? ''), invoiceName: String(input.invoiceName ?? ''), externalReference: String(input.externalReference ?? '') } };
      default:
        throw new OperationRefused('UNKNOWN_OPERATION', `${op.operation} cannot be built.`);
    }
  }

  /** An asynchronous answer arrived (already authenticated). Finishes the operation if it matches one of ours. */
  async completeFromResult(providerId: string, payload: unknown): Promise<{ matched: boolean; op?: ProviderOperationRow; reason?: string }> {
    const result = parseAsyncResult(payload);
    if (!result) return { matched: false, reason: 'The body is not a Daraja result.' };
    const byOriginator = has(result.originatorId) ? await this.ops.byOriginator(providerId, result.originatorId) : null;
    const byConversation = !byOriginator && has(result.conversationId) ? await this.ops.byConversation(providerId, result.conversationId) : null;
    const op = byOriginator ?? byConversation;
    if (!op) return { matched: false, reason: 'No operation of ours has this originator or conversation id.' };
    if (['succeeded', 'failed', 'cancelled', 'rejected'].includes(op.status)) return { matched: true, op, reason: 'Already finished.' };
    // The conversation id sent back must be the one the platform gave us when it accepted the request.
    if (has(op.conversationId) && has(result.conversationId) && op.conversationId !== result.conversationId) {
      return { matched: false, reason: 'The conversation id does not match the one the platform gave for this request.' };
    }
    const ok = result.resultCode === '0';
    const params = result.params;
    const moneyOut = DARAJA_OPERATIONS[op.operation as DarajaOperationCode]?.moneyOut;
    // An answer is only trusted as "money moved" when it names the transaction. Without that it is held for a person.
    if (ok && moneyOut && !looksLikeReceipt(receiptFromParams(params) ?? result.transactionId ?? '')) {
      await this.ops.update(op.id, { status: 'in_doubt', conversationId: op.conversationId ?? result.conversationId, result: { resultCode: result.resultCode, resultDesc: result.resultDesc, params }, failureCode: 'NO_RECEIPT', failureReason: 'Safaricom said the payout succeeded but gave no transaction number. Check it on the M-Pesa statement before doing anything else.', nextAttemptAt: null });
      return { matched: true, op: (await this.ops.get(op.id)), reason: 'Held: no transaction number.' };
    }
    // A payout's "success" is only the callback's word until Safaricom's own record of the transaction agrees (settled by the engine).
    const awaitingCheck = ok && moneyOut;
    await this.ops.update(op.id, {
      status: awaitingCheck ? 'accepted' : ok ? 'succeeded' : 'failed',
      ...(awaitingCheck ? { nextAttemptAt: new Date(Date.now() + 15 * 60_000) } : {}),
      conversationId: op.conversationId ?? result.conversationId,
      platformReference: receiptFromParams(params) ?? result.transactionId,
      result: { resultCode: result.resultCode, resultDesc: result.resultDesc, params, references: result.references, transactionId: result.transactionId },
      failureCode: ok ? null : result.resultCode || 'RESULT_FAILED',
      failureReason: ok ? null : (result.resultDesc ?? 'The platform reported a failure.'),
    });
    return { matched: true, op: (await this.ops.get(op.id)) };
  }

  /** The platform said it timed the request out in its queue. The operation is not dead: it must be checked, never assumed. */
  async markTimedOut(providerId: string, payload: unknown): Promise<{ matched: boolean; op?: ProviderOperationRow }> {
    const body = (payload ?? {}) as Record<string, unknown>;
    const result = parseAsyncResult(body);
    const originator = result?.originatorId ?? (typeof body.OriginatorConversationID === 'string' ? body.OriginatorConversationID : null);
    const op = has(originator) ? await this.ops.byOriginator(providerId, originator) : null;
    if (!op) return { matched: false };
    if (['succeeded', 'failed', 'cancelled', 'rejected'].includes(op.status)) return { matched: true, op };
    await this.ops.update(op.id, { status: 'timed_out', failureCode: 'QUEUE_TIMEOUT', failureReason: 'The platform timed this request out before processing it. It has to be checked, not assumed.', nextAttemptAt: new Date(Date.now() + 120 * 1000) });
    return { matched: true, op: (await this.ops.get(op.id)) };
  }

  paramsOf(result: Record<string, unknown>): Record<string, string> {
    return resultParameters({ ResultParameters: (result as { ResultParameters?: unknown }).ResultParameters });
  }
}

/** One invoice in the form Bill Manager takes: phone in 254 form, due date with a time, and at least one line item. */
function billInvoice(input: Record<string, unknown>) {
  return {
    externalReference: String(input.externalReference),
    billedFullName: String(input.billedFullName),
    billedPhoneNumber: toMsisdn(String(input.billedPhoneNumber)) ?? String(input.billedPhoneNumber),
    billedPeriod: String(input.billedPeriod),
    invoiceName: String(input.invoiceName),
    dueDate: /\d{2}:\d{2}/.test(String(input.dueDate)) ? String(input.dueDate) : `${String(input.dueDate)} 00:00:00.00`,
    accountReference: String(input.accountReference),
    amount: String(input.amount),
    invoiceItems: Array.isArray(input.invoiceItems) ? input.invoiceItems : [{ itemName: String(input.invoiceName), amount: String(input.amount) }],
  };
}
