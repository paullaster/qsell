import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { providerTransactions, type ProviderTransactionRow, type ProviderTransactionState } from '@/server/db/drizzle/schema';

export interface ClaimInput {
  companyId: string;
  providerId: string;
  methodId?: string | null;
  kind: string;
  platformReference: string;
  amount: string;
  currency?: string;
  payerMasked?: string | null;
  payerHash?: string | null;
  shortcode?: string | null;
  accountReference?: string | null;
  occurredAt?: Date | null;
}

/**
 * Money the platform says moved: claimed from a callback, confirmed by asking the platform, and
 * counted exactly once. The unique key (provider, platform reference) and the database triggers are
 * what make a replayed or forged callback unable to count a payment twice.
 */
export class ProviderTransactionStore {
  constructor(private readonly db: DrizzleDb) {}

  async claim(input: ClaimInput): Promise<{ row: ProviderTransactionRow; created: boolean; amountDiffers: boolean }> {
    const [row] = await this.db
      .insert(providerTransactions)
      .values({
        companyId: input.companyId,
        providerId: input.providerId,
        methodId: input.methodId ?? null,
        kind: input.kind,
        platformReference: input.platformReference,
        amount: input.amount,
        currency: input.currency ?? 'KES',
        payerMasked: input.payerMasked ?? null,
        payerHash: input.payerHash ?? null,
        shortcode: input.shortcode ?? null,
        accountReference: input.accountReference ?? null,
        occurredAt: input.occurredAt ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (row) return { row, created: true, amountDiffers: false };
    const [existing] = await this.db
      .select()
      .from(providerTransactions)
      .where(and(eq(providerTransactions.providerId, input.providerId), eq(providerTransactions.platformReference, input.platformReference)));
    return { row: existing!, created: false, amountDiffers: Number(existing!.amount) !== Number(input.amount) };
  }

  async byReference(providerId: string, platformReference: string) {
    const [row] = await this.db
      .select()
      .from(providerTransactions)
      .where(and(eq(providerTransactions.providerId, providerId), eq(providerTransactions.platformReference, platformReference)));
    return row ?? null;
  }

  async get(id: string) {
    const [row] = await this.db.select().from(providerTransactions).where(eq(providerTransactions.id, id));
    return row ?? null;
  }

  async addEvidence(id: string, evidence: Record<string, unknown>, by: string) {
    await this.db
      .update(providerTransactions)
      .set({
        evidence: sql`${providerTransactions.evidence} || ${JSON.stringify([{ by, at: new Date().toISOString(), ...evidence }])}::jsonb`,
        updatedAt: new Date(),
      })
      .where(and(eq(providerTransactions.id, id), isNull(providerTransactions.consumedAt)));
  }

  async setState(id: string, state: ProviderTransactionState, extra: { verifiedBy?: string; failureCode?: string | null; failureReason?: string | null } = {}) {
    await this.db
      .update(providerTransactions)
      .set({
        state,
        updatedAt: new Date(),
        ...(state === 'verified' || state === 'review' ? { verifiedAt: new Date(), verifiedBy: extra.verifiedBy ?? null } : {}),
        ...(extra.failureCode !== undefined ? { failureCode: extra.failureCode, failureReason: extra.failureReason ?? null } : {}),
      })
      .where(and(eq(providerTransactions.id, id), isNull(providerTransactions.consumedAt)));
  }

  /** Counts the transaction against something, once. False when it was already counted (by anyone). */
  async consume(id: string, type: string, targetId: string): Promise<boolean> {
    const done = await this.db
      .update(providerTransactions)
      .set({ state: 'consumed', consumedType: type, consumedId: targetId, consumedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(providerTransactions.id, id), isNull(providerTransactions.consumedAt), sql`${providerTransactions.state} IN ('verified','review')`))
      .returning({ id: providerTransactions.id });
    return done.length > 0;
  }
}
