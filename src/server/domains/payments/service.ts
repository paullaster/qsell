import type { DrizzleDb } from '@/server/db/drizzle/client';
import { companySettings, paymentAttempts, paymentProviderConfigs, providerTransactions, type BranchRow } from '@/server/db/drizzle/schema';
import { and, eq, ne } from 'drizzle-orm';
import { newSecret } from './engine/redact';
import type { PaymentEngine } from './engine/payment-engine';
import type { AttemptSettler } from './engine/verification-service';
import type { InitiatePaymentResult } from './port';
import { type PaymentRegistry } from './registry';
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

import { has } from '@/lib/has';
import { readText } from '@/lib/values';

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export class PaymentService implements AttemptSettler {
  private readonly orderRepo: OrderRepository;
  private engine: PaymentEngine | null = null;

  constructor(
    private readonly db: DrizzleDb,
    private readonly registry: PaymentRegistry,
    private readonly configs = new PaymentConfigRepository(db),
    private readonly attempts = new PaymentAttemptRepository(db),
  ) {
    this.orderRepo = new OrderRepository(db);
  }

  /** The engine is built after the service (it needs it to settle payments), so it is attached afterwards. */
  useEngine(engine: PaymentEngine) {
    this.engine = engine;
  }

  async resolvePublicBaseUrl(branch: BranchRow): Promise<string> {
    if (has(branch?.publicBaseUrl?.trim())) return branch.publicBaseUrl.replace(/\/$/, '');
    const companies = await this.db
      .select()
      .from(companySettings)
      .where(eq(companySettings.id, branch.companyId))
      .limit(1);
    const companyUrl = companies[0]?.publicBaseUrl?.trim();
    if (has(companyUrl)) return companyUrl.replace(/\/$/, '');
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

  /**
   * The provider (and the payment method) a checkout for this branch and service goes through: a
   * method of the branch, or of every branch, whose provider is switched on. A branch that has no
   * method for the service yet still gets the provider that was configured for it the older way.
   */
  async resolveCheckout(branch: BranchRow, providerCode: PaymentProviderCode) {
    const candidates = await this.configs.checkoutCandidates(branch.companyId, branch.id);
    const hit = candidates.find((c) => c.providerCode === providerCode);
    if (hit) {
      const provider = await this.configs.getById(hit.providerId);
      if (provider) return { provider, methodId: hit.methodId as string | null };
    }
    const legacy = await this.configs.getByBranchAndProvider(branch.id, providerCode);
    return legacy && legacy.isEnabled ? { provider: legacy, methodId: null as string | null } : null;
  }

  /** One provider per service that this branch can offer at checkout. */
  async listEnabledProviders(branch: BranchRow) {
    const out = new Map<string, Awaited<ReturnType<PaymentConfigRepository['getById']>> & object>();
    for (const c of await this.configs.checkoutCandidates(branch.companyId, branch.id)) {
      if (out.has(c.providerCode)) continue;
      const provider = await this.configs.getById(c.providerId);
      if (provider) out.set(c.providerCode, provider);
    }
    for (const row of await this.configs.listByBranch(branch.id)) {
      if (row.isEnabled && !out.has(row.providerCode)) out.set(row.providerCode, row);
    }
    return [...out.values()];
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
    const resolved = await this.resolveCheckout(params.branch, params.providerCode);
    if (resolved?.provider.isEnabled !== true) {
      throw new Error(`Payment provider ${params.providerCode} is not enabled for this branch`);
    }
    const config = resolved.provider;
    const credentials = decryptCredentials(config.credentialsEncrypted);
    if (!credentials) {
      throw new Error(
        `No credentials saved for ${PAYMENT_PROVIDER_META[params.providerCode].label}. Configure them in admin.`,
      );
    }

    const publicBaseUrl = await this.resolvePublicBaseUrl(params.branch);
    // An unguessable secret, not a time-ordered id: whoever knows the address can announce a payment for it.
    const callbackToken = newSecret();
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
    let result: InitiatePaymentResult;
    if (params.providerCode === 'mpesa_daraja' && this.engine) {
      // Written down before it is sent, logged when it is, and checked with Safaricom afterwards.
      result = await this.startDarajaStk(config.id, resolved.methodId, attempt.id, callbackUrl, params);
    } else {
      result = await adapter.initiate(
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
        config.settings ?? {},
        config.apiBaseUrl,
      );
    }

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

    if (status !== 'failed' && this.engine) {
      // Whether or not a callback arrives, the payment is checked with the platform.
      const { engineSettings } = await import('./engine/settings');
      await this.engine.jobs.verifyAttempt(attempt.id, engineSettings(config.settings).verification.pollSeconds[0] ?? 15).catch((e) => console.error('[payments] could not schedule the check', e));
    }

    await this.orderRepo.update(params.orderId, {
      paymentStatus: status === 'failed' ? 'failed' : 'pending_verification',
      ...(status === 'failed' ? { status: 'failed' as const } : {}),
      paymentMethod: params.providerCode,
      // The finance method it goes through decides which bank account and G/L account it posts to.
      ...(has(resolved.methodId) ? { paymentMethodId: resolved.methodId } : {}),
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

  private async startDarajaStk(
    providerId: string,
    methodId: string | null,
    attemptId: string,
    callbackUrl: string,
    params: { orderNumber: string; amount: number; customerPhone: string; description?: string },
  ): Promise<InitiatePaymentResult> {
    const { op } = await this.engine!.daraja.start({
      providerId,
      methodId,
      operation: 'stk_push',
      input: { amount: params.amount, phone: params.customerPhone, callbackUrl, accountReference: params.orderNumber, description: params.description ?? `Order ${params.orderNumber}` },
      idempotencyKey: `stk:${attemptId}`,
      subject: { type: 'payment_attempt', id: attemptId },
      origin: { surface: 'storefront', action: 'checkout' },
    }).catch((error: unknown) => ({ op: null, error }));
    if (!op || op.status !== 'accepted') {
      return { status: 'failed', errorMessage: op?.failureReason ?? 'M-Pesa Express could not be started.', rawResponse: (op?.response ?? {}) };
    }
    const r = op.response;
    return {
      status: 'pending',
      providerReference: readText(r.CheckoutRequestID, op.conversationId, ''),
      externalReference: readText(r.MerchantRequestID, ''),
      customerMessage: readText(r.CustomerMessage, 'STK push sent'),
      rawResponse: r,
    };
  }

  /** Has a verified transaction already been counted for this attempt? */
  async isSettled(attemptId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: providerTransactions.id })
      .from(providerTransactions)
      .where(and(eq(providerTransactions.consumedType, 'payment_attempt'), eq(providerTransactions.consumedId, attemptId)))
      .limit(1);
    return Boolean(row);
  }

  /**
   * The platform itself confirmed this payment (and it agrees with what we asked for): only now does the
   * order become paid. Safe to run again: every step it takes is idempotent.
   */
  async succeed(attemptId: string, input: { reference: string | null; verifiedBy: string; transactionId: string }): Promise<{ settled: boolean }> {
    const [attempt] = await this.db.select().from(paymentAttempts).where(eq(paymentAttempts.id, attemptId));
    if (!attempt) return { settled: false };
    await this.db
      .update(paymentAttempts)
      .set({ status: 'successful', paidAt: attempt.paidAt ?? new Date(), errorMessage: null, updatedAt: new Date() })
      .where(and(eq(paymentAttempts.id, attemptId), ne(paymentAttempts.status, 'cancelled')));
    // A checkout id is not a receipt. The platform confirmed the payment, so the order is paid; the ledger credit
    // needs the platform's own transaction number and waits for it (the reconcile screen lists it) if none came.
    const real = has(input.reference) && !input.reference.startsWith('ws_CO_') ? input.reference : null;
    const receiptProviders = attempt.providerCode === 'mpesa_daraja' || attempt.providerCode === 'kcb_buni';
    await this.orderRepo.update(attempt.orderId, {
      paymentStatus: 'paid',
      status: 'processing',
      mpesaReceiptNumber: receiptProviders ? real : null,
      transactionReference: real,
    });
    await InventoryReservationService.fulfilOrder(attempt.orderId);
    await getContainer().customers.applyOrderPayment(attempt.orderId);
    if (has(real)) await getContainer().transactionReconcile.reconcileSuccessfulPaymentAttempt(attemptId);
    return { settled: true };
  }

  /** The platform itself says it did not go through. */
  async fail(attemptId: string, input: { reason: string; code: string | null }): Promise<{ settled: boolean }> {
    const [attempt] = await this.db.select().from(paymentAttempts).where(eq(paymentAttempts.id, attemptId));
    if (!attempt || attempt.status === 'successful') return { settled: false };
    await this.db.update(paymentAttempts).set({ status: 'failed', errorMessage: input.reason.slice(0, 500), updatedAt: new Date() }).where(eq(paymentAttempts.id, attemptId));
    await this.orderRepo.update(attempt.orderId, { paymentStatus: 'failed', status: 'failed' });
    await InventoryReservationService.releaseOrder(attempt.orderId, 'payment_callback_failed', `payment:${attempt.providerCode}`);
    return { settled: true };
  }
}
