import { and, eq, desc } from 'drizzle-orm';
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

  async listByBranch(branchId: string): Promise<PaymentProviderConfigRow[]> {
    return this.db
      .select()
      .from(paymentProviderConfigs)
      .where(eq(paymentProviderConfigs.branchId, branchId))
      .orderBy(paymentProviderConfigs.providerCode);
  }

  async getByBranchAndProvider(
    branchId: string,
    providerCode: PaymentProviderCode,
  ): Promise<PaymentProviderConfigRow | null> {
    const rows = await this.db
      .select()
      .from(paymentProviderConfigs)
      .where(
        and(
          eq(paymentProviderConfigs.branchId, branchId),
          eq(paymentProviderConfigs.providerCode, providerCode),
        ),
      )
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

  async upsert(input: {
    branchId: string;
    providerCode: PaymentProviderCode;
    displayName: string;
    isEnabled: boolean;
    environment: 'staging' | 'production';
    apiBaseUrl: string;
    credentialsEncrypted?: EncryptedCredentialsBlob | null;
    settings?: Record<string, unknown>;
    replaceCredentials?: boolean;
  }): Promise<PaymentProviderConfigRow> {
    const existing = await this.getByBranchAndProvider(input.branchId, input.providerCode);
    const now = new Date();

    if (existing) {
      const [updated] = await this.db
        .update(paymentProviderConfigs)
        .set({
          displayName: input.displayName,
          isEnabled: input.isEnabled,
          environment: input.environment,
          apiBaseUrl: input.apiBaseUrl.replace(/\/$/, ''),
          settings: input.settings ?? existing.settings ?? {},
          credentialsEncrypted: input.replaceCredentials
            ? (input.credentialsEncrypted ?? null)
            : existing.credentialsEncrypted,
          updatedAt: now,
        })
        .where(eq(paymentProviderConfigs.id, existing.id))
        .returning();
      return updated!;
    }

    const [created] = await this.db
      .insert(paymentProviderConfigs)
      .values({
        branchId: input.branchId,
        providerCode: input.providerCode,
        displayName: input.displayName,
        isEnabled: input.isEnabled,
        environment: input.environment,
        apiBaseUrl: input.apiBaseUrl.replace(/\/$/, ''),
        credentialsEncrypted: input.credentialsEncrypted ?? null,
        settings: input.settings ?? {},
      })
      .returning();
    return created!;
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
