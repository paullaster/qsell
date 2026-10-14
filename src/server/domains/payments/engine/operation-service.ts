import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { providerOperations, type ProviderOperationRow, type ProviderOperationStatus } from '@/server/db/drizzle/schema';
import { redactDeep } from './redact';

export interface CreateOperation {
  companyId: string;
  providerId: string;
  methodId?: string | null;
  operation: string;
  idempotencyKey: string;
  originatorId?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
  amount?: string | null;
  currency?: string | null;
  /** What to send (no secrets): kept so a failed send can be repeated exactly. */
  input?: Record<string, unknown>;
  request?: Record<string, unknown>;
  requestedBy?: string | null;
  origin?: Record<string, unknown>;
  status?: ProviderOperationStatus;
  expiresAt?: Date | null;
}

const ACTIVE: ProviderOperationStatus[] = ['queued', 'submitted', 'accepted', 'timed_out', 'in_doubt'];

/**
 * The record of every request to a platform. Asked once (the same request twice is the same
 * operation), moved through its states only forward, and never deleted, so what happened to any
 * request, and why it failed, can always be read back.
 */
export class ProviderOperationService {
  constructor(private readonly db: DrizzleDb) {}

  async create(input: CreateOperation): Promise<{ op: ProviderOperationRow; created: boolean }> {
    const [row] = await this.db
      .insert(providerOperations)
      .values({
        companyId: input.companyId,
        providerId: input.providerId,
        methodId: input.methodId ?? null,
        operation: input.operation,
        status: input.status ?? 'created',
        idempotencyKey: input.idempotencyKey,
        originatorId: input.originatorId ?? null,
        subjectType: input.subjectType ?? null,
        subjectId: input.subjectId ?? null,
        amount: input.amount ?? null,
        currency: input.currency ?? null,
        input: input.input ?? {},
        request: redactDeep(input.request ?? {}),
        requestedBy: input.requestedBy ?? null,
        origin: input.origin ?? {},
        expiresAt: input.expiresAt ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (row) return { op: row, created: true };
    const [existing] = await this.db
      .select()
      .from(providerOperations)
      .where(and(eq(providerOperations.companyId, input.companyId), eq(providerOperations.idempotencyKey, input.idempotencyKey)));
    return { op: existing, created: false };
  }

  async get(id: string) {
    const [row] = await this.db.select().from(providerOperations).where(eq(providerOperations.id, id));
    return row ?? null;
  }

  async byOriginator(providerId: string, originatorId: string) {
    const [row] = await this.db
      .select()
      .from(providerOperations)
      .where(and(eq(providerOperations.providerId, providerId), eq(providerOperations.originatorId, originatorId)));
    return row ?? null;
  }

  async byConversation(providerId: string, conversationId: string) {
    const [row] = await this.db
      .select()
      .from(providerOperations)
      .where(and(eq(providerOperations.providerId, providerId), eq(providerOperations.conversationId, conversationId)));
    return row ?? null;
  }

  async bySubject(subjectType: string, subjectId: string, operation?: string) {
    return await this.db
      .select()
      .from(providerOperations)
      .where(and(eq(providerOperations.subjectType, subjectType), eq(providerOperations.subjectId, subjectId), operation ? eq(providerOperations.operation, operation) : undefined))
      .orderBy(asc(providerOperations.createdAt));
  }

  async update(
    id: string,
    patch: Partial<{
      status: ProviderOperationStatus;
      conversationId: string | null;
      platformReference: string | null;
      request: Record<string, unknown>;
      response: Record<string, unknown>;
      result: Record<string, unknown>;
      failureCode: string | null;
      failureReason: string | null;
      nextAttemptAt: Date | null;
      attempts: number;
      originatorId: string | null;
    }>,
  ) {
    const terminal = patch.status && ['succeeded', 'failed', 'cancelled', 'rejected'].includes(patch.status);
    const [row] = await this.db
      .update(providerOperations)
      .set({
        ...patch,
        request: patch.request ? redactDeep(patch.request) : undefined,
        response: patch.response ? redactDeep(patch.response) : undefined,
        result: patch.result ? redactDeep(patch.result) : undefined,
        updatedAt: new Date(),
        ...(terminal ? { completedAt: new Date(), nextAttemptAt: null } : {}),
      })
      .where(eq(providerOperations.id, id))
      .returning();
    return row ?? null;
  }

  async bumpAttempts(id: string) {
    await this.db.update(providerOperations).set({ attempts: sql`${providerOperations.attempts} + 1`, updatedAt: new Date() }).where(eq(providerOperations.id, id));
  }

  /** Operations whose turn has come (to be asked about again). */
  async due(limit = 100) {
    return await this.db
      .select()
      .from(providerOperations)
      .where(and(inArray(providerOperations.status, ACTIVE), lte(providerOperations.nextAttemptAt, new Date())))
      .orderBy(asc(providerOperations.nextAttemptAt))
      .limit(limit);
  }
}
