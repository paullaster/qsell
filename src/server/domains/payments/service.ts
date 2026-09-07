import { v7 as uuidv7 } from 'uuid';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { companySettings, type BranchRow } from '@/server/db/drizzle/schema';
import { eq } from 'drizzle-orm';
import { PaymentRegistry } from './registry';
import { PaymentAttemptRepository, PaymentConfigRepository } from './repository';
import { decryptCredentials } from './crypto';
import { PAYMENT_PROVIDER_META, type PaymentProviderCode } from './types';
import type { CallbackResult } from './port';
import { OrderRepository } from '@/server/domains/orders/repository';
import { db as memoryDb } from '@/server/db/store';
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
    if (branch.publicBaseUrl?.trim()) return branch.publicBaseUrl.replace(/\/$/, '');
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

  buildCallbackUrl(publicBaseUrl: string, providerCode: PaymentProviderCode, token: string): string {
    const prefix = PAYMENT_PROVIDER_META[providerCode].callbackPathPrefix;
    return `${publicBaseUrl.replace(/\/$/, '')}${prefix}/${token}`;
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
    const config = await this.configs.getByBranchAndProvider(
      params.branch.id,
      params.providerCode,
    );
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
      paymentMethod: params.providerCode as PaymentProvider,
      transactionReference: result.providerReference ?? null,
    });

    const mem = memoryDb.orders.get(params.orderId);
    if (mem) {
      mem.paymentStatus = status === 'failed' ? 'failed' : 'pending_verification';
      mem.paymentMethod = params.providerCode as PaymentProvider;
      mem.transactionReference = result.providerReference || mem.transactionReference;
      mem.updatedAt = new Date().toISOString();
    }

    return { attempt: updated, result };
  }

  async handleProviderCallback(params: {
    providerCode: PaymentProviderCode;
    callbackToken: string;
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

    await this.attempts.recordCallbackEvent({
      paymentAttemptId: attempt?.id ?? null,
      callbackToken: params.callbackToken,
      providerCode: params.providerCode,
      httpMethod: params.request.method,
      headers: headersToRecord(params.request.headers),
      rawBody: body,
      processingStatus: attempt ? 'received' : 'unmatched_token',
      processingError: attempt ? null : 'No payment attempt for callback token',
    });

    if (!attempt) {
      return {
        httpStatus: 404,
        body: { ResultCode: 1, ResultDesc: 'Unknown callback token' },
        callback: { ok: false, status: 'failed', errorMessage: 'Unknown callback token' },
      };
    }

    if (attempt.providerCode !== params.providerCode) {
      return {
        httpStatus: 400,
        body: { ResultCode: 1, ResultDesc: 'Provider mismatch' },
        callback: { ok: false, status: 'failed', errorMessage: 'Provider mismatch' },
      };
    }

    const config = await this.configs.getById(attempt.providerConfigId);
    const credentials = decryptCredentials(config?.credentialsEncrypted) || {};
    const adapter = this.registry.resolve(params.providerCode);
    const callback = await adapter.handleCallback(
      {
        callbackToken: params.callbackToken,
        headers: headersToRecord(params.request.headers),
        body,
        rawBodyText: text,
      },
      credentials,
      (config?.settings as Record<string, unknown>) || {},
    );

    const nextStatus =
      callback.status === 'successful'
        ? 'successful'
        : callback.status === 'failed'
          ? 'failed'
          : 'pending';

    await this.attempts.update(attempt.id, {
      status: nextStatus,
      providerReference: callback.providerReference || attempt.providerReference,
      externalReference: callback.externalReference || attempt.externalReference,
      responsePayload: callback.raw || {},
      errorMessage: callback.errorMessage ?? null,
      paidAt: callback.status === 'successful' ? new Date() : null,
    });

    if (callback.status === 'successful') {
      await this.orderRepo.update(attempt.orderId, {
        paymentStatus: 'paid',
        status: 'processing',
        mpesaReceiptNumber: callback.receiptNumber ?? null,
        transactionReference: callback.providerReference ?? null,
      });
    } else if (callback.status === 'failed') {
      await this.orderRepo.update(attempt.orderId, {
        paymentStatus: 'failed',
      });
    }

    const mem = memoryDb.orders.get(attempt.orderId);
    if (mem) {
      if (callback.status === 'successful') {
        mem.paymentStatus = 'paid';
        mem.status = mem.status === 'pending' ? 'processing' : mem.status;
        mem.mpesaReceiptNumber = callback.receiptNumber || mem.mpesaReceiptNumber;
        mem.transactionReference = callback.providerReference || mem.transactionReference;
      } else if (callback.status === 'failed') {
        mem.paymentStatus = 'failed';
      }
      mem.updatedAt = new Date().toISOString();
    }

    await this.attempts.recordCallbackEvent({
      paymentAttemptId: attempt.id,
      callbackToken: params.callbackToken,
      providerCode: params.providerCode,
      httpMethod: params.request.method,
      headers: headersToRecord(params.request.headers),
      rawBody: body,
      processingStatus: callback.status,
      processingError: callback.errorMessage ?? null,
    });

    return {
      httpStatus: 200,
      body: { ResultCode: 0, ResultDesc: 'Accepted' },
      callback,
    };
  }
}
