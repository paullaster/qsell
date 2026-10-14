import { and, asc, eq, desc, ne, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  paymentProviderConfigs,
  paymentAttempts,
  paymentCallbackEvents,
  type PaymentProviderConfigRow,
  type PaymentAttemptRow,
} from '@/server/db/drizzle/schema';
import type {
  PaymentProviderCode,
  PaymentAttemptStatus,
  EncryptedCredentialsBlob,
  CallbackProcessingStatus,
  CallbackOutcome,
} from './types';

export class PaymentConfigRepository {
  constructor(private readonly db: DrizzleDb) {}

  /** Every provider of the company, the built-in Manual one included. */
  async listByCompany(companyId: string): Promise<PaymentProviderConfigRow[]> {
    return this.db
      .select()
      .from(paymentProviderConfigs)
      .where(eq(paymentProviderConfigs.companyId, companyId))
      .orderBy(asc(paymentProviderConfigs.isSystem), asc(paymentProviderConfigs.displayName));
  }

  /**
   * The older way: providers that were configured for one branch (kept so a branch that has no payment
   * method for a service yet still offers it at checkout).
   */
  async listByBranch(branchId: string): Promise<PaymentProviderConfigRow[]> {
    return this.db
      .select()
      .from(paymentProviderConfigs)
      .where(and(eq(paymentProviderConfigs.branchId, branchId), ne(paymentProviderConfigs.providerCode, 'manual')))
      .orderBy(paymentProviderConfigs.providerCode);
  }

  async getByBranchAndProvider(
    branchId: string,
    providerCode: PaymentProviderCode,
  ): Promise<PaymentProviderConfigRow | null> {
    const rows = await this.db
      .select()
      .from(paymentProviderConfigs)
      .where(and(eq(paymentProviderConfigs.branchId, branchId), eq(paymentProviderConfigs.providerCode, providerCode)))
      .limit(1);
    return rows[0] ?? null;
  }

  async getById(id: string): Promise<PaymentProviderConfigRow | null> {
    const rows = await this.db
      .select()
      .from(paymentProviderConfigs)
      .where(eq(paymentProviderConfigs.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * What the storefront may offer a branch: payment methods of that branch (or of every branch) that
   * go through a service which is switched on. First the branch's own methods, then by sort order.
   */
  async checkoutCandidates(companyId: string, branchId: string | null) {
    const res = await this.db.execute<{ method_id: string; provider_id: string; provider_code: string }>(sql`
      SELECT m.id AS method_id, p.id AS provider_id, p.provider_code
      FROM payment_methods m
      JOIN payment_provider_configs p ON p.id = m.provider_id
      WHERE m.company_id = ${companyId}::uuid AND m.enabled = true AND m.usable_for ? 'customer_receipt'
        AND p.provider_code <> 'manual' AND p.is_enabled = true
        AND (m.branch_id IS NULL OR m.branch_id = ${branchId}::uuid)
      ORDER BY (m.branch_id IS NULL) ASC, m.sort_order ASC, m.code ASC`);
    return [...res].map((r) => ({ methodId: r.method_id, providerId: r.provider_id, providerCode: r.provider_code as PaymentProviderCode }));
  }

  /** Remembers the last "Test connection" so the screen can show when it last worked. */
  async recordTest(id: string, ok: boolean, message: string): Promise<void> {
    await this.db
      .update(paymentProviderConfigs)
      .set({ lastTestAt: new Date(), lastTestOk: ok, lastTestMessage: message.slice(0, 500) })
      .where(eq(paymentProviderConfigs.id, id));
  }

  async create(input: {
    companyId: string;
    providerCode: PaymentProviderCode;
    displayName: string;
    environment: 'staging' | 'production';
    apiBaseUrl: string;
    settings?: Record<string, unknown>;
  }): Promise<PaymentProviderConfigRow> {
    const [row] = await this.db
      .insert(paymentProviderConfigs)
      .values({
        companyId: input.companyId,
        branchId: null,
        providerCode: input.providerCode,
        displayName: input.displayName,
        isEnabled: false,
        environment: input.environment,
        apiBaseUrl: input.apiBaseUrl.replace(/\/$/, ''),
        settings: input.settings ?? {},
      })
      .returning();
    return row!;
  }

  async update(
    id: string,
    patch: Partial<{
      displayName: string;
      isEnabled: boolean;
      environment: 'staging' | 'production';
      apiBaseUrl: string;
      credentialsEncrypted: EncryptedCredentialsBlob | null;
      settings: Record<string, unknown>;
    }>,
  ): Promise<PaymentProviderConfigRow> {
    const [row] = await this.db
      .update(paymentProviderConfigs)
      .set({ ...patch, ...(patch.apiBaseUrl ? { apiBaseUrl: patch.apiBaseUrl.replace(/\/$/, '') } : {}), updatedAt: new Date() })
      .where(eq(paymentProviderConfigs.id, id))
      .returning();
    if (!row) throw new Error('That provider does not exist.');
    return row;
  }

  async remove(id: string): Promise<void> {
    await this.db.delete(paymentProviderConfigs).where(eq(paymentProviderConfigs.id, id));
  }
}

export class PaymentAttemptRepository {
  constructor(private readonly db: DrizzleDb) {}

  async create(input: {
    branchId: string;
    providerConfigId: string;
    providerCode: PaymentProviderCode;
    orderId: string;
    orderNumber: string;
    amount: string;
    currency: string;
    callbackToken: string;
    callbackUrl: string;
    customerPhone?: string;
    customerEmail?: string;
    requestPayload?: Record<string, unknown>;
  }): Promise<PaymentAttemptRow> {
    const [row] = await this.db
      .insert(paymentAttempts)
      .values({
        ...input,
        status: 'initiated',
        requestPayload: input.requestPayload ?? {},
      })
      .returning();
    return row!;
  }

  async getByCallbackToken(token: string): Promise<PaymentAttemptRow | null> {
    const rows = await this.db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.callbackToken, token))
      .limit(1);
    return rows[0] ?? null;
  }

  async getById(id: string): Promise<PaymentAttemptRow | null> {
    const rows = await this.db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async listByOrder(orderId: string): Promise<PaymentAttemptRow[]> {
    return this.db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.orderId, orderId))
      .orderBy(desc(paymentAttempts.createdAt));
  }

  async update(
    id: string,
    patch: Partial<{
      status: PaymentAttemptStatus;
      providerReference: string | null;
      externalReference: string | null;
      redirectUrl: string | null;
      responsePayload: Record<string, unknown>;
      errorMessage: string | null;
      paidAt: Date | null;
    }>,
  ): Promise<PaymentAttemptRow> {
    const [row] = await this.db
      .update(paymentAttempts)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(paymentAttempts.id, id))
      .returning();
    if (!row) throw new Error(`Payment attempt ${id} not found`);
    return row;
  }

  async recordCallbackEvent(input: {
    paymentAttemptId: string | null;
    callbackToken: string;
    providerCode: PaymentProviderCode;
    httpMethod: string;
    headers: Record<string, string>;
    rawBody: unknown;
    processingStatus: CallbackProcessingStatus;
    outcome?: CallbackOutcome;
    processingError?: string | null;
  }) {
    const [row] = await this.db
      .insert(paymentCallbackEvents)
      .values({
        paymentAttemptId: input.paymentAttemptId,
        callbackToken: input.callbackToken,
        providerCode: input.providerCode,
        httpMethod: input.httpMethod,
        headers: input.headers,
        rawBody: input.rawBody,
        processingStatus: input.processingStatus,
        outcome: input.outcome ?? 'unclassified',
        processingError: input.processingError ?? null,
      })
      .returning();
    return row!;
  }

  async updateCallbackEvent(
    id: string,
    patch: {
      processingStatus: CallbackProcessingStatus;
      outcome: CallbackOutcome;
      processingError?: string | null;
    },
  ) {
    const [row] = await this.db
      .update(paymentCallbackEvents)
      .set({
        processingStatus: patch.processingStatus,
        outcome: patch.outcome,
        processingError: patch.processingError ?? null,
      })
      .where(eq(paymentCallbackEvents.id, id))
      .returning();
    return row ?? null;
  }

  async listCallbackEvents(limit = 100) {
    return this.db
      .select()
      .from(paymentCallbackEvents)
      .orderBy(desc(paymentCallbackEvents.createdAt))
      .limit(limit);
  }
}
