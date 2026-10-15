import type { CallbackOutcome, PaymentProviderCode } from './types';

import { has } from '@/lib/has';

export interface CallbackStatusVerdict {
  /**
   * The exact status value the provider sent in the callback payload, verbatim.
   * mpesa_daraja / kcb_buni: Body.stkCallback.ResultCode (e.g. "0", "1", "1032").
   * pesapal_v3: payment status text (e.g. "COMPLETED", "FAILED", "PENDING").
   * jenga_hq: status / transactionStatus / state text.
   * null when the payload has no recognizable status field.
   */
  rawStatus: string | null;
  /**
   * Outcome derived from rawStatus below. unclassified when rawStatus is null
   * or the provider value is not a status we know how to interpret.
   */
  outcome: CallbackOutcome;
}

/**
 * The single, explicit system definition of how a callback determines whether
 * a payment was successful or a failure.
 *
 * payment_callback_events.processing_status keeps the verbatim provider status
 * from the payload; payment_callback_events.outcome is derived from it here.
 * Success/failure is decided from the provider payload — never from the HTTP
 * status of the callback request.
 */
export function classifyCallbackPayload(
  providerCode: PaymentProviderCode,
  rawBody: unknown,
): CallbackStatusVerdict {
  const rawStatus = extractCallbackStatus(providerCode, rawBody);
  return {
    rawStatus,
    outcome: rawStatus == null ? 'unclassified' : deriveCallbackOutcome(providerCode, rawStatus),
  };
}

/**
 * Copy the provider's own status field out of the payload, verbatim.
 * Each provider stores it in a different place; extract that exact value.
 */
export function extractCallbackStatus(
  providerCode: PaymentProviderCode,
  rawBody: unknown,
): string | null {
  const body = rawBody as {
    Body?: { stkCallback?: { ResultCode?: number | string } };
    ResultCode?: number | string;
    resultCode?: number | string;
    statusCode?: number | string;
    status?: unknown;
    payment_status_description?: unknown;
    OrderNotificationType?: unknown;
    transactionStatus?: unknown;
    state?: unknown;
  };
  if (!body || typeof body !== 'object') return null;

  switch (providerCode) {
    case 'mpesa_daraja': {
      const code = body.Body?.stkCallback?.ResultCode;
      return code == null ? null : String(code);
    }
    case 'kcb_buni': {
      const code =
        body.Body?.stkCallback?.ResultCode ?? body.ResultCode ?? body.resultCode ?? body.statusCode;
      if (code != null) return String(code);
      return typeof body.status === 'string' && has(body.status) ? body.status : null;
    }
    case 'pesapal_v3': {
      const text = body.payment_status_description ?? body.status ?? body.OrderNotificationType;
      if (text == null) return null;
      const value = String(text);
      return has(value) ? value : null;
    }
    case 'jenga_hq': {
      const text = body.status ?? body.transactionStatus ?? body.state;
      if (text == null) return null;
      const value = String(text);
      return has(value) ? value : null;
    }
    default:
      return null;
  }
}

/**
 * Rulebook: what each provider status value means for the outcome.
 *
 * M-Pesa Daraja (and KCB Buni STK, which mirrors it):
 *   Body.stkCallback.ResultCode === 0 is the ONLY success — every other value
 *   (1, 1032, …) is a failure.
 */
export function deriveCallbackOutcome(
  providerCode: PaymentProviderCode,
  rawStatus: string,
): CallbackOutcome {
  switch (providerCode) {
    case 'mpesa_daraja':
      return rawStatus.trim() === '0' ? 'successful' : 'failed';
    case 'kcb_buni': {
      const code = rawStatus.trim();
      if (code === '0') return 'successful';
      if (/^[1-9]\d*$/.test(code)) return 'failed';
      return statusWordOutcome(rawStatus);
    }
    case 'pesapal_v3': {
      const s = rawStatus.trim().toUpperCase();
      if (s === 'COMPLETED' || s === 'PAID') return 'successful';
      if (s === 'PENDING' || s === 'AWAITING_PAYMENT') return 'pending';
      if (
        s === 'FAILED' ||
        s === 'REVERSED' ||
        s === 'DECLINED' ||
        s === 'EXPIRED' ||
        s === 'CANCELLED' ||
        s === 'INVALID'
      ) {
        return 'failed';
      }
      return 'unclassified';
    }
    case 'jenga_hq':
      return statusWordOutcome(rawStatus);
    default:
      return 'unclassified';
  }
}

function statusWordOutcome(rawStatus: string): CallbackOutcome {
  const s = rawStatus.trim().toLowerCase();
  if (
    s.includes('success') ||
    s.includes('complete') ||
    s.includes('paid') ||
    s === '0'
  ) {
    return 'successful';
  }
  if (
    s.includes('fail') ||
    s.includes('error') ||
    s.includes('declin') ||
    s.includes('cancelled') ||
    s.includes('cancel') ||
    s.includes('revers') ||
    s.includes('expire')
  ) {
    return 'failed';
  }
  if (s === 'pending' || s.includes('await')) return 'pending';
  return 'unclassified';
}