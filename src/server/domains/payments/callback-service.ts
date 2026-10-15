import { desc, eq, or } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  paymentCallbackEvents,
  type PaymentCallbackEventRow,
} from '@/server/db/drizzle/schema';
import { type PaymentRegistry } from './registry';
import { type PaymentConfigRepository, type PaymentAttemptRepository } from './repository';
import { decryptCredentials } from './crypto';
import { classifyCallbackPayload } from './callback-status';
import type { CallbackResult } from './port';
import type { PaymentProviderCode } from './types';

import { has } from '@/lib/has';

/**
 * Manual classification of a stored payment_callback_events dump.
 *
 * processing_status keeps the exact status the provider sent.
 * outcome is derived from that status by the callback rulebook:
 * M-Pesa stkCallback.ResultCode 0 is successful; any other ResultCode is a failure.
 * This never posts the transaction ledger and never retries the payment.
 */
export class PaymentCallbackService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly registry: PaymentRegistry,
    private readonly configs: PaymentConfigRepository,
    private readonly attempts: PaymentAttemptRepository,
  ) {}

  /** Dumps that still have no verdict — unclassified or errored mid-classification. */
  async listRequiringReview(limit = 50): Promise<PaymentCallbackEventRow[]> {
    return await this.db
      .select()
      .from(paymentCallbackEvents)
      .where(
        or(
          eq(paymentCallbackEvents.outcome, 'unclassified'),
          eq(paymentCallbackEvents.processingStatus, 'error'),
        ),
      )
      .orderBy(desc(paymentCallbackEvents.createdAt))
      .limit(limit);
  }

  /**
   * Read the stored payload and persist the provider status plus the outcome
   * derived from it. Does not post the ledger.
   */
  async classify(eventId: string): Promise<PaymentCallbackEventRow> {
    const [event] = await this.db
      .select()
      .from(paymentCallbackEvents)
      .where(eq(paymentCallbackEvents.id, eventId))
      .limit(1);
    if (!event) throw new Error('Callback event not found.');

    const verdict = classifyCallbackPayload(
      event.providerCode,
      event.rawBody,
    );
    if (has(verdict.rawStatus)) {
      const [updated] = await this.db
        .update(paymentCallbackEvents)
        .set({
          processingStatus: verdict.rawStatus,
          outcome: verdict.outcome,
          processingError: null,
        })
        .where(eq(paymentCallbackEvents.id, eventId))
        .returning();
      return updated;
    }

    const attempt = has(event.paymentAttemptId)
      ? await this.attempts.getById(event.paymentAttemptId)
      : null;
    if (!attempt) {
      throw new Error(
        'This callback has no recognizable provider status and no linked payment attempt.',
      );
    }

    const config = await this.configs.getById(attempt.providerConfigId);
    const credentials = decryptCredentials(config?.credentialsEncrypted) || {};
    const adapter = this.registry.resolve(event.providerCode);

    let result: CallbackResult;
    try {
      result = await adapter.handleCallback(
        {
          callbackToken: event.callbackToken,
          headers: event.headers ?? {},
          body: event.rawBody ?? null,
          rawBodyText: event.rawBody ? JSON.stringify(event.rawBody) : '',
        },
        credentials,
        (config?.settings!) || {},
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Classification failed';
      const [failed] = await this.db
        .update(paymentCallbackEvents)
        .set({
          processingStatus: 'error',
          outcome: 'unclassified',
          processingError: message,
        })
        .where(eq(paymentCallbackEvents.id, eventId))
        .returning();
      return failed;
    }

    const [updated] = await this.db
      .update(paymentCallbackEvents)
      .set({
        processingStatus: 'received',
        outcome: result.status,
        processingError: result.errorMessage ?? null,
      })
      .where(eq(paymentCallbackEvents.id, eventId))
      .returning();
    return updated;
  }
}