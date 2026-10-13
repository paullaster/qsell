import { v7 as uuidv7 } from 'uuid';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { companySettings, paymentProviderConfigs, type BranchRow } from '@/server/db/drizzle/schema';
import { eq } from 'drizzle-orm';
import { PaymentRegistry } from './registry';
import { PaymentAttemptRepository, PaymentConfigRepository } from './repository';
import { decryptCredentials, encryptCredentials, needsResealing } from './crypto';
import { PAYMENT_PROVIDER_META, type PaymentProviderCode } from './types';
import { classifyCallbackPayload } from './callback-status';
import { extractPaymentReference } from './payment-reference';
import type { CallbackResult } from './port';
import { OrderRepository } from '@/server/domains/orders/repository';
import { getContainer } from '@/server/di/container';
import { InventoryReservationService } from '@/server/domains/inventory/reservation-service';
import type { PaymentProvider } from '@/types/index';

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export class PaymentService {
  private readonly orderRepo: OrderRepository;

  constructor(
    private readonly db: DrizzleDb,
    private readonly registry: PaymentRegistry,
    private readonly configs = new PaymentConfigRepository(db),
    private readonly attempts = new PaymentAttemptRepository(db),
  ) {
    this.orderRepo = new OrderRepository(db);
  }

  async resolvePublicBaseUrl(branch: BranchRow): Promise<string> {
    if (branch?.publicBaseUrl?.trim()) return branch.publicBaseUrl.replace(/\/$/, '');
    const companies = await this.db
      .select()
      .from(companySettings)
      .where(eq(companySettings.id, branch.companyId))
      .limit(1);
    const companyUrl = companies[0]?.publicBaseUrl?.trim();
    if (companyUrl) return companyUrl.replace(/\/$/, '');
    throw new Error(
      'Public base URL is not configured. Set it on the company or branch in Settings so payment callbacks can be built.',
    );
  }

  buildCallbackUrl(
    publicBaseUrl: string,
    providerCode: PaymentProviderCode,
    token: string,
  ): string {
    const prefix = PAYMENT_PROVIDER_META[providerCode].callbackPathPrefix;
    return `${publicBaseUrl.replace(/\/$/, '')}${prefix}/${token}`;
  }

  /**
   * Signs in to the provider with the credentials saved for this branch account, without moving
   * money, and remembers the result. Never returns or logs a credential.
   */
  async testConnection(configId: string): Promise<{ ok: boolean; message: string; at: Date }> {
    const config = await this.configs.getById(configId);
    if (!config) throw new Error('That provider account does not exist.');
    const code = config.providerCode as PaymentProviderCode;
    let result: { ok: boolean; message: string };
    try {
      const credentials = decryptCredentials(config.credentialsEncrypted);
      if (!credentials) {
        result = { ok: false, message: 'No credentials are saved for this provider yet.' };
      } else {
        result = await this.registry
          .resolve(code)
          .testConnection(credentials, config.settings ?? {}, config.apiBaseUrl);
      }
    } catch (error) {
      result = { ok: false, message: error instanceof Error ? error.message.slice(0, 300) : 'The test could not run.' };
    }
    await this.configs.recordTest(config.id, result.ok, result.message);
    return { ...result, at: new Date() };
  }

  /**
   * Seals credentials that were sealed under an older key (or before keys had ids) again under the
   * current one, so a retired key can eventually be dropped. A row that cannot be opened is
   * reported, never overwritten.
   */
  async resealCredentials(): Promise<{ resealed: number; failed: { id: string; reason: string }[] }> {
    const rows = await this.db.select().from(paymentProviderConfigs);
    let resealed = 0;
    const failed: { id: string; reason: string }[] = [];
    for (const row of rows) {
      if (!needsResealing(row.credentialsEncrypted)) continue;
      try {
        const plain = decryptCredentials(row.credentialsEncrypted);
        if (!plain) continue;
        await this.db
          .update(paymentProviderConfigs)
          .set({ credentialsEncrypted: encryptCredentials(plain), updatedAt: new Date() })
          .where(eq(paymentProviderConfigs.id, row.id));
        resealed += 1;
      } catch (error) {
        failed.push({ id: row.id, reason: error instanceof Error ? error.message.slice(0, 160) : 'unknown' });
      }
    }
    return { resealed, failed };
  }

  capabilitiesOf(code: PaymentProviderCode): readonly string[] {
    return this.registry.resolve(code).capabilities;
  }

  async listEnabledProviders(branchId: string) {
    const rows = await this.configs.listByBranch(branchId);
    return rows.filter((r) => r.isEnabled);
  }

  async initiatePayment(params: {
    branch: BranchRow;
    providerCode: PaymentProviderCode;
    orderId: string;
    orderNumber: string;
    amount: number;
    currency: string;
    customerName: string;
    customerEmail: string;
    customerPhone: string;
    description?: string;
  }) {
    const config = await this.configs.getByBranchAndProvider(params.branch.id, params.providerCode);
    if (!config || !config.isEnabled) {
      throw new Error(`Payment provider ${params.providerCode} is not enabled for this branch`);
    }
    const credentials = decryptCredentials(config.credentialsEncrypted);
    if (!credentials) {
      throw new Error(
        `No credentials saved for ${PAYMENT_PROVIDER_META[params.providerCode].label}. Configure them in admin.`,
      );
    }

    const publicBaseUrl = await this.resolvePublicBaseUrl(params.branch);
    const callbackToken = uuidv7();
    const callbackUrl = this.buildCallbackUrl(publicBaseUrl, params.providerCode, callbackToken);

    const attempt = await this.attempts.create({
      branchId: params.branch.id,
      providerConfigId: config.id,
      providerCode: params.providerCode,
      orderId: params.orderId,
      orderNumber: params.orderNumber,
      amount: params.amount.toFixed(2),
      currency: params.currency,
      callbackToken,
      callbackUrl,
      customerPhone: params.customerPhone,
      customerEmail: params.customerEmail,
      requestPayload: {
        amount: params.amount,
        currency: params.currency,
        orderId: params.orderId,
      },
    });

    const adapter = this.registry.resolve(params.providerCode);
    const result = await adapter.initiate(
      {
        attemptId: attempt.id,
        orderId: params.orderId,
        orderNumber: params.orderNumber,
        amount: params.amount,
        currency: params.currency,
        customerName: params.customerName,
        customerEmail: params.customerEmail,
        customerPhone: params.customerPhone,
        callbackUrl,
        description: params.description,
      },
      credentials,
      (config.settings as Record<string, unknown>) || {},
      config.apiBaseUrl,
    );

    const status =
      result.status === 'failed'
        ? 'failed'
        : result.status === 'awaiting_redirect'
          ? 'awaiting_redirect'
          : 'pending';

    const updated = await this.attempts.update(attempt.id, {
      status,
      providerReference: result.providerReference ?? null,
      externalReference: result.externalReference ?? null,
      redirectUrl: result.redirectUrl ?? null,
      responsePayload: result.rawResponse ?? {},
      errorMessage: result.errorMessage ?? null,
    });

    await this.orderRepo.update(params.orderId, {
      paymentStatus: status === 'failed' ? 'failed' : 'pending_verification',
      ...(status === 'failed' ? { status: 'failed' as const } : {}),
      paymentMethod: params.providerCode as PaymentProvider,
    });

    if (status === 'failed') {
      await InventoryReservationService.releaseOrder(
        params.orderId,
        'payment_initiation_failed',
        `payment:${params.providerCode}`,
      );
    }

    return { attempt: updated, result };
  }

  async handleProviderCallback(params: {
    providerCode: PaymentProviderCode;
    callbackToken: string;
    receiptEventId?: string;
    request: Request;
  }): Promise<{ httpStatus: number; body: Record<string, unknown>; callback: CallbackResult }> {
    const attempt = await this.attempts.getByCallbackToken(params.callbackToken);
    let body: unknown = null;
    const text = await params.request.text();
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }

    // Dump the payload as sent. processing_status is the provider's own status
    // (M-Pesa: stkCallback.ResultCode). outcome is derived from that status.
    const verdict = classifyCallbackPayload(params.providerCode, body);
    const dumpStatus = verdict.rawStatus ?? (attempt ? 'received' : 'unmatched_token');
    const dumpOutcome = verdict.rawStatus ? verdict.outcome : 'unclassified';
    const receiptEventId =
      params.receiptEventId ??
      (
        await this.attempts.recordCallbackEvent({
          paymentAttemptId: attempt?.id ?? null,
          callbackToken: params.callbackToken,
          providerCode: params.providerCode,
          httpMethod: params.request.method,
          headers: headersToRecord(params.request.headers),
          rawBody: body,
          processingStatus: dumpStatus,
          outcome: dumpOutcome,
          processingError: attempt ? null : 'No payment attempt for callback token',
        })
      ).id;

    if (!attempt) {
      return {
        httpStatus: 404,
        body: { ResultCode: 1, ResultDesc: 'Unknown callback token' },
        callback: { ok: false, status: 'failed', errorMessage: 'Unknown callback token' },
      };
    }

    if (attempt.providerCode !== params.providerCode) {
      await this.attempts.updateCallbackEvent(receiptEventId, {
        processingStatus: verdict.rawStatus ?? 'error',
        outcome: verdict.rawStatus ? verdict.outcome : 'failed',
        processingError: 'Provider mismatch',
      });
      return {
        httpStatus: 400,
        body: { ResultCode: 1, ResultDesc: 'Provider mismatch' },
        callback: { ok: false, status: 'failed', errorMessage: 'Provider mismatch' },
      };
    }

    const config = await this.configs.getById(attempt.providerConfigId);
    const credentials = decryptCredentials(config?.credentialsEncrypted) || {};
    const adapter = this.registry.resolve(params.providerCode);
    let callback: CallbackResult;
    try {
      callback = await adapter.handleCallback(
        {
          callbackToken: params.callbackToken,
          headers: headersToRecord(params.request.headers),
          body,
          rawBodyText: text,
        },
        credentials,
        (config?.settings as Record<string, unknown>) || {},
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Callback classification failed';
      await this.attempts.updateCallbackEvent(receiptEventId, {
        processingStatus: verdict.rawStatus ?? 'error',
        outcome: verdict.rawStatus ? verdict.outcome : 'unclassified',
        processingError: message,
      });
      throw err;
    }

    // The rulebook decides success vs failure from the provider status.
    // The adapter still supplies the receipt and references.
    const outcome = verdict.rawStatus ? verdict.outcome : callback.status;
    await this.attempts.updateCallbackEvent(receiptEventId, {
      processingStatus: verdict.rawStatus ?? callback.status,
      outcome,
      processingError: callback.errorMessage ?? null,
    });

    const nextStatus =
      outcome === 'successful' ? 'successful' : outcome === 'failed' ? 'failed' : 'pending';

    const paymentReference =
      outcome === 'successful'
        ? callback.receiptNumber?.trim() || extractPaymentReference(params.providerCode, body) || ''
        : '';
    if (outcome === 'successful' && !paymentReference) {
      await this.attempts.updateCallbackEvent(receiptEventId, {
        processingStatus: verdict.rawStatus ?? callback.status,
        outcome,
        processingError: 'Successful payment callback had no transaction reference.',
      });
    }

    await this.attempts.update(attempt.id, {
      status: outcome === 'successful' && !paymentReference ? 'pending' : nextStatus,
      providerReference: callback.providerReference || attempt.providerReference,
      externalReference: callback.externalReference || attempt.externalReference,
      responsePayload: callback.raw || {},
      errorMessage:
        outcome === 'successful' && !paymentReference
          ? 'Successful payment callback had no transaction reference.'
          : (callback.errorMessage ?? null),
      paidAt: outcome === 'successful' && paymentReference ? new Date() : null,
    });

    if (outcome === 'successful' && paymentReference) {
      const receiptProviders =
        params.providerCode === 'mpesa_daraja' || params.providerCode === 'kcb_buni';
      await this.orderRepo.update(attempt.orderId, {
        paymentStatus: 'paid',
        status: 'processing',
        mpesaReceiptNumber: receiptProviders ? paymentReference : null,
        transactionReference: paymentReference,
      });
      await InventoryReservationService.fulfilOrder(attempt.orderId);
      await getContainer().customers.applyOrderPayment(attempt.orderId);
      await getContainer().transactionReconcile.reconcileSuccessfulPaymentAttempt(attempt.id);
    } else if (outcome === 'failed') {
      await this.orderRepo.update(attempt.orderId, {
        paymentStatus: 'failed',
        status: 'failed',
      });
      await InventoryReservationService.releaseOrder(
        attempt.orderId,
        'payment_callback_failed',
        `payment:${params.providerCode}`,
      );
    }

    return {
      httpStatus: 200,
      body: { ResultCode: 0, ResultDesc: 'Accepted' },
      callback,
    };
  }
}
