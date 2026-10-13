import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { paymentAttempts, paymentMethods, paymentProviderConfigs, providerEvents, providerOperations, providerTransactions } from '@/server/db/drizzle/schema';

/** What has happened on the payment platforms, for the people who watch over it. Read-only. */
export class PaymentActivityService {
  constructor(private readonly db: DrizzleDb) {}

  /** What needs a person: payments that could not be confirmed, contradictions, requests with no answer. */
  async attention(companyId: string) {
    const [events, ops, txs, doubtful] = await Promise.all([
      this.db
        .select()
        .from(providerEvents)
        .where(and(eq(providerEvents.companyId, companyId), inArray(providerEvents.state, ['mismatch', 'unverified', 'unmatched', 'rejected']), sql`${providerEvents.kind} NOT IN ('c2b_validation')`))
        .orderBy(desc(providerEvents.createdAt))
        .limit(50),
      this.db.select().from(providerOperations).where(and(eq(providerOperations.companyId, companyId), inArray(providerOperations.status, ['failed', 'in_doubt', 'timed_out']))).orderBy(desc(providerOperations.createdAt)).limit(50),
      this.db.select().from(providerTransactions).where(and(eq(providerTransactions.companyId, companyId), inArray(providerTransactions.state, ['review', 'claimed', 'rejected']))).orderBy(desc(providerTransactions.createdAt)).limit(50),
      this.db
        .select({ a: paymentAttempts })
        .from(paymentAttempts)
        .innerJoin(paymentProviderConfigs, eq(paymentProviderConfigs.id, paymentAttempts.providerConfigId))
        .where(and(eq(paymentProviderConfigs.companyId, companyId), inArray(paymentAttempts.status, ['pending', 'awaiting_redirect']), lt(paymentAttempts.createdAt, new Date(Date.now() - 30 * 60_000))))
        .orderBy(desc(paymentAttempts.createdAt))
        .limit(50),
    ]);
    return { events, operations: ops, transactions: txs, doubtful: doubtful.map((d) => d.a) };
  }

  async operations(companyId: string, f: { providerId?: string; before?: string; limit?: number } = {}) {
    const rows = await this.db
      .select({ op: providerOperations, provider: paymentProviderConfigs.displayName, method: paymentMethods.name })
      .from(providerOperations)
      .innerJoin(paymentProviderConfigs, eq(paymentProviderConfigs.id, providerOperations.providerId))
      .leftJoin(paymentMethods, eq(paymentMethods.id, providerOperations.methodId))
      .where(and(eq(providerOperations.companyId, companyId), f.providerId ? eq(providerOperations.providerId, f.providerId) : undefined, f.before ? lt(providerOperations.createdAt, new Date(f.before)) : undefined))
      .orderBy(desc(providerOperations.createdAt))
      .limit(Math.min(f.limit ?? 50, 200));
    return rows;
  }

  async events(companyId: string, f: { state?: string; before?: string; limit?: number } = {}) {
    return this.db
      .select({ ev: providerEvents, provider: paymentProviderConfigs.displayName })
      .from(providerEvents)
      .innerJoin(paymentProviderConfigs, eq(paymentProviderConfigs.id, providerEvents.providerId))
      .where(and(eq(providerEvents.companyId, companyId), f.state ? eq(providerEvents.state, f.state as never) : undefined, f.before ? lt(providerEvents.createdAt, new Date(f.before)) : undefined))
      .orderBy(desc(providerEvents.createdAt))
      .limit(Math.min(f.limit ?? 50, 200));
  }

  async transactions(companyId: string, f: { state?: string; before?: string; limit?: number } = {}) {
    return this.db
      .select({ tx: providerTransactions, provider: paymentProviderConfigs.displayName, method: paymentMethods.name })
      .from(providerTransactions)
      .innerJoin(paymentProviderConfigs, eq(paymentProviderConfigs.id, providerTransactions.providerId))
      .leftJoin(paymentMethods, eq(paymentMethods.id, providerTransactions.methodId))
      .where(and(eq(providerTransactions.companyId, companyId), f.state ? eq(providerTransactions.state, f.state as never) : undefined, f.before ? lt(providerTransactions.createdAt, new Date(f.before)) : undefined))
      .orderBy(desc(providerTransactions.createdAt))
      .limit(Math.min(f.limit ?? 50, 200));
  }

  async counts(companyId: string) {
    const [row] = await this.db.execute<{ ops_failed: number; ops_open: number; events_bad: number; tx_review: number; tx_claimed: number; tx_consumed: number }>(sql`
      SELECT
        (SELECT COUNT(*)::int FROM provider_operations WHERE company_id = ${companyId}::uuid AND status IN ('failed','in_doubt','timed_out')) AS ops_failed,
        (SELECT COUNT(*)::int FROM provider_operations WHERE company_id = ${companyId}::uuid AND status IN ('queued','submitted','accepted')) AS ops_open,
        (SELECT COUNT(*)::int FROM provider_events WHERE company_id = ${companyId}::uuid AND state IN ('mismatch','unverified','unmatched','rejected') AND kind <> 'c2b_validation') AS events_bad,
        (SELECT COUNT(*)::int FROM provider_transactions WHERE company_id = ${companyId}::uuid AND state = 'review') AS tx_review,
        (SELECT COUNT(*)::int FROM provider_transactions WHERE company_id = ${companyId}::uuid AND state = 'claimed') AS tx_claimed,
        (SELECT COUNT(*)::int FROM provider_transactions WHERE company_id = ${companyId}::uuid AND state = 'consumed') AS tx_consumed`);
    return row!;
  }
}
