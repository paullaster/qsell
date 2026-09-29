import type { JobHelpers } from 'graphile-worker';
import { getContainer } from '@/server/di/container';
import { ReconciliationEngine } from '@/server/domains/reconciliation/service';
import { InventoryReservationService } from '@/server/domains/inventory/reservation-service';
import { broadcastRealtime } from '@/server/realtime';
import type { PaymentProviderCode } from '@/server/domains/payments/types';

interface ProcessPaymentCallbackPayload {
  auditId: string;
  correlationId: string;
  provider: string;
  callbackToken?: string;
  callbackEventId?: string;
  rawPayload: string;
  headers: Record<string, string>;
}

interface ProcessWebhookPayload {
  auditId: string;
  correlationId: string;
  provider: string;
  operation: string;
  payload: Record<string, unknown>;
  headers: Record<string, string>;
}

interface RetryFailedCallPayload {
  auditId: string;
  attempt: number;
}

/** Worker task: process a payment gateway callback (M-Pesa, Pesapal, etc.). */
export const processPaymentCallback = async (
  payload: ProcessPaymentCallbackPayload,
  helpers: { logger: any },
) => {
  const { auditId, correlationId, provider, rawPayload, headers } = payload;
  helpers.logger.info(`Processing ${provider} callback`, { auditId, correlationId });

  const container = getContainer();

  // Tokenized callbacks belong to PaymentAttempt, not the legacy payment
  // transaction table. Reuse the canonical provider callback handler so the
  // attempt, order, inventory, and customer ledger stay in sync.
  if (payload.callbackToken) {
    try {
      const attempt = await container.paymentAttempts.getByCallbackToken(payload.callbackToken);
      const request = new Request('http://worker.internal/payment-callback', {
        method: 'POST',
        headers,
        body: rawPayload,
      });
      const result = await container.payments.handleProviderCallback({
        providerCode: provider as PaymentProviderCode,
        callbackToken: payload.callbackToken,
        receiptEventId: payload.callbackEventId,
        request,
      });
      await container.paymentRecords.updateAuditLog(auditId, {
        statusCode: result.httpStatus,
        responsePayload: {
          processedAt: new Date().toISOString(),
          httpStatus: result.httpStatus,
          outcome: result.callback.status,
          callbackOk: result.callback.ok,
          errorMessage: result.callback.errorMessage ?? null,
          providerReference: result.callback.providerReference ?? null,
          externalReference: result.callback.externalReference ?? null,
          receiptNumber: result.callback.receiptNumber ?? null,
          acknowledgement: result.body,
        },
        errorCode: result.callback.status === 'failed' ? 'PAYMENT_CALLBACK_FAILED' : null,
        errorMessage: result.callback.errorMessage ?? null,
      });
      await broadcastRealtime('payment_callback_processed', {
        type: result.callback.status,
        provider,
        callbackToken: payload.callbackToken,
        orderId: attempt?.orderId,
      });
      helpers.logger.info(`Callback processed: ${result.callback.status}`, {
        auditId,
        correlationId,
      });
    } catch (err) {
      await container.paymentRecords.updateAuditLog(auditId, {
        errorCode: 'CALLBACK_PROCESSING_FAILED',
        errorMessage: err instanceof Error ? err.message : 'Payment callback processing failed',
      });
      throw err;
    }
    return;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(rawPayload);
  } catch {
    helpers.logger.error('Invalid JSON in callback payload');
    await container.paymentRecords.updateAuditLog(auditId, {
      errorCode: 'INVALID_JSON',
      errorMessage: 'Callback payload is not valid JSON',
    });
    return;
  }

  let transactionReference: string | null = null;
  let orderId: string | null = null;

  if (provider === 'mpesa_daraja') {
    const cb = (parsed?.Body?.stkCallback as any) ?? {};
    transactionReference = ((cb.CheckoutRequestID ?? cb.MerchantRequestID) as string) ?? null;
  } else if (provider === 'pesapal_v3') {
    transactionReference = ((parsed.OrderTrackingId ?? parsed.MerchantReference) as string) ?? null;
  } else if (provider === 'jenga_hq') {
    transactionReference = ((parsed.transactionReference ?? parsed.reference) as string) ?? null;
  } else if (provider === 'kcb_buni') {
    transactionReference =
      ((parsed.CheckoutRequestID ?? parsed.MerchantReference) as string) ?? null;
  }

  if (!transactionReference) {
    helpers.logger.warn('Could not extract transaction reference');
    await container.paymentRecords.updateAuditLog(auditId, {
      errorCode: 'MISSING_REFERENCE',
      errorMessage: 'No transaction reference found in callback',
    });
    return;
  }

  const tx = await container.paymentRecords.findTransaction({ transactionReference });
  if (!tx) {
    helpers.logger.warn('Transaction not found for reference', { transactionReference });
    await container.paymentRecords.updateAuditLog(auditId, {
      errorCode: 'TX_NOT_FOUND',
      errorMessage: `No transaction record for reference ${transactionReference}`,
    });
    return;
  }

  orderId = tx.orderId;

  await container.paymentRecords.updateTransaction(tx.id, {
    callbackPayload: parsed,
    callbackReceivedAt: new Date(),
    callbackAuditId: auditId,
  });

  await container.paymentRecords.updateAuditLog(auditId, {
    callbackReceivedAt: new Date(),
  });

  let outcome: 'successful' | 'failed' | 'pending' = 'pending';
  let paymentReference: string | null = null;
  let errorMessage: string | null = null;

  if (provider === 'mpesa_daraja') {
    const cb = (parsed?.Body?.stkCallback as any) ?? {};
    const resultCode = Number(cb.ResultCode);
    if (resultCode === 0) {
      outcome = 'successful';
      const meta = (cb?.CallbackMetadata?.Item as any[]) ?? [];
      for (const item of meta) {
        if (item.Name === 'MpesaReceiptNumber') paymentReference = String(item.Value);
      }
    } else {
      outcome = 'failed';
      errorMessage = (cb.ResultDesc as string) ?? 'M-Pesa payment failed';
    }
  } else if (provider === 'pesapal_v3') {
    const status = String(parsed.Status ?? '').toUpperCase();
    if (status === 'COMPLETED' || status === 'SUCCESS') {
      outcome = 'successful';
      paymentReference = parsed.OrderTrackingId as string;
    } else if (status === 'FAILED' || status === 'CANCELLED') {
      outcome = 'failed';
      errorMessage = (parsed.FailureReason as string) ?? 'Pesapal payment failed';
    }
  }

  if (outcome === 'successful' && paymentReference) {
    await container.paymentRecords.updateTransaction(tx.id, {
      status: 'successful',
      transactionReference: paymentReference,
      externalReference: paymentReference,
      ipnStatus: 'delivered',
      reconciliationStatus: 'pending',
    });

    await container.orders.update(orderId!, {
      paymentStatus: 'paid',
      status: 'processing',
      transactionReference: paymentReference,
      mpesaReceiptNumber:
        provider === 'mpesa_daraja' || provider === 'kcb_buni' ? paymentReference : null,
    });

    await InventoryReservationService.fulfilOrder(orderId!);

    const updatedTx = await container.paymentRecords.getTransactionById(tx.id);
    const updatedOrder = await container.orders.getById(orderId!);
    if (updatedTx && updatedOrder) {
      await ReconciliationEngine.reconcileSingleTransaction(
        updatedTx as any,
        updatedOrder as any,
        'async_callback',
      );
    }

    await container.paymentRecords.updateTransaction(tx.id, {
      reconciliationStatus: 'reconciled',
      callbackReceivedAt: new Date(),
    });

    void broadcastRealtime('payment_callback_processed', {
      type: 'success',
      orderId,
      provider,
      transactionReference: paymentReference,
    });
  } else if (outcome === 'failed') {
    await container.paymentRecords.updateTransaction(tx.id, {
      status: 'failed',
      errorMessage,
      ipnStatus: 'delivered',
      reconciliationStatus: 'pending',
    });

    await container.orders.update(orderId!, {
      paymentStatus: 'failed',
      status: 'failed',
    });

    await InventoryReservationService.releaseOrder(
      orderId!,
      errorMessage ?? 'payment_failed',
      provider,
    );

    void broadcastRealtime('payment_callback_processed', {
      type: 'failed',
      orderId,
      provider,
      error: errorMessage,
    });
  }

  helpers.logger.info(`Callback processed: ${outcome}`, { orderId, auditId });
};

/** Worker task: process a generic webhook (non-payment). */
export const processWebhook = async (payload: ProcessWebhookPayload, helpers: { logger: any }) => {
  helpers.logger.info(`Processing webhook ${payload.provider}.${payload.operation}`, {
    auditId: payload.auditId,
  });
  await getContainer().paymentRecords.updateAuditLog(payload.auditId, {
    callbackReceivedAt: new Date(),
  });
};

/** Worker task: retry a failed outbound call. */
export const retryFailedCall = async (
  payload: RetryFailedCallPayload,
  helpers: { logger: any },
) => {
  helpers.logger.info(`Retrying failed call`, {
    auditId: payload.auditId,
    attempt: payload.attempt,
  });
  const audit = await getContainer().paymentRecords.getAuditLogById(payload.auditId);
  if (!audit) {
    helpers.logger.warn('Audit log not found for retry');
    return;
  }
  await getContainer().paymentRecords.updateAuditLog(payload.auditId, {
    retryCount: payload.attempt,
  });
};

/** Tokens are kept a week after they stop working, for support/audit questions. */
const AUTH_TOKEN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Worker cron task: delete expired or used email-verification / password-reset tokens. */
export const purgeAuthTokens = async (_payload: unknown, helpers: JobHelpers) => {
  const removed = await getContainer().authTokens.purgeUnusable(
    new Date(Date.now() - AUTH_TOKEN_RETENTION_MS),
  );
  helpers.logger.info(`Purged ${removed} unusable auth tokens`);
};

export const tasks = {
  'process-payment-callback': processPaymentCallback,
  'process-webhook': processWebhook,
  'retry-failed-call': retryFailedCall,
  'purge-auth-tokens': purgeAuthTokens,
};
