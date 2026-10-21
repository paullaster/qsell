import { and, eq, gte, notInArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { refundLimits, refundRequests, type RefundLimitsRow } from '@/server/db/drizzle/schema';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { fromCents, toCents } from '../domain/receivables';
import { NO_LIMITS, destinationOf, type RefundLimitValues, type VelocityUsage } from '../domain/refund-limits';
import { FinanceError, type FinanceContext } from '../errors';
import type { Tx } from '../engine';

type Reader = Pick<DrizzleDb, 'select' | 'execute'>;

export interface RefundLimitsView {
  values: RefundLimitValues;
  version: number;
  updatedBy: string | null;
  updatedAt: string | null;
}

const centsOrNull = (n: string | null): number | null => (n === null ? null : toCents(n));

function valuesOf(row: RefundLimitsRow | undefined): RefundLimitValues {
  if (row === undefined) return NO_LIMITS;
  return {
    enabled: row.enabled,
    windowHours: row.windowHours,
    maxPerCustomer: row.maxPerCustomer,
    maxCentsPerCustomer: centsOrNull(row.maxAmountPerCustomer),
    maxPerDestination: row.maxPerDestination,
    maxPerRequester: row.maxPerRequester,
    maxCentsPerRequester: centsOrNull(row.maxAmountPerRequester),
    mode: row.mode,
  };
}

/** How fast refunds may be asked for. One row per company; nothing is limited until someone sets it. */
export class RefundLimitsService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
  ) {}

  async get(w: Reader, companyId: string): Promise<RefundLimitValues> {
    const [row] = await w.select().from(refundLimits).where(eq(refundLimits.companyId, companyId));
    return valuesOf(row);
  }

  async view(companyId: string): Promise<RefundLimitsView> {
    const [row] = await this.db.select().from(refundLimits).where(eq(refundLimits.companyId, companyId));
    return { values: valuesOf(row), version: row?.version ?? 0, updatedBy: row?.updatedBy ?? null, updatedAt: row?.updatedAt.toISOString() ?? null };
  }

  /** Saves the limits. `expectedVersion` is what the person saw (0 when nothing was saved yet): someone else's save in between is refused. */
  async save(ctx: FinanceContext, values: RefundLimitValues, expectedVersion: number): Promise<RefundLimitsView> {
    const writes = {
      enabled: values.enabled,
      windowHours: values.windowHours,
      maxPerCustomer: values.maxPerCustomer,
      maxAmountPerCustomer: values.maxCentsPerCustomer === null ? null : fromCents(values.maxCentsPerCustomer),
      maxPerDestination: values.maxPerDestination,
      maxPerRequester: values.maxPerRequester,
      maxAmountPerRequester: values.maxCentsPerRequester === null ? null : fromCents(values.maxCentsPerRequester),
      mode: values.mode,
      updatedBy: ctx.actor.id,
      updatedAt: new Date(),
    };
    await this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(refundLimits).where(eq(refundLimits.companyId, ctx.companyId)).for('update');
      if ((current?.version ?? 0) !== expectedVersion) throw new FinanceError('CHANGED_SINCE', 'Someone else changed the refund limits while you were looking at them. Reload to see their version.');
      if (current === undefined) await tx.insert(refundLimits).values({ companyId: ctx.companyId, ...writes });
      else await tx.update(refundLimits).set({ ...writes, version: current.version + 1 }).where(eq(refundLimits.companyId, ctx.companyId));
      await this.decisions.record(
        { companyId: ctx.companyId, subject: { type: 'refund_limits', id: ctx.companyId }, action: 'finance.refund_limits_saved', actor: ctx.actor, inputs: { origin: ctx.origin, before: valuesOf(current) }, outcome: { ...values } },
        tx,
      );
    });
    return await this.view(ctx.companyId);
  }

  /**
   * What already happened in the window, before the refund being asked for: this customer's, this destination's and this
   * person's refunds that still stand (not cancelled or turned down). Three counting queries, whatever the volume.
   */
  async usage(tx: Tx, p: { companyId: string; customerId: string; requester: string; kind: string; details: Record<string, string | undefined>; windowHours: number; now?: Date }): Promise<VelocityUsage> {
    const since = new Date((p.now ?? new Date()).getTime() - p.windowHours * 3_600_000);
    const standing = and(eq(refundRequests.companyId, p.companyId), gte(refundRequests.createdAt, since), notInArray(refundRequests.status, ['cancelled', 'rejected']));
    const sums = { n: sql<number>`count(*)::int`, cents: sql<string>`COALESCE(SUM(${refundRequests.amount}), 0)::text` };
    const destination = destinationOf(p.kind, p.details);
    const [customer, requester, atDestination] = await Promise.all([
      tx.select(sums).from(refundRequests).where(and(standing, eq(refundRequests.customerId, p.customerId))),
      tx.select(sums).from(refundRequests).where(and(standing, eq(refundRequests.requestedBy, p.requester))),
      destination === null
        ? Promise.resolve(null)
        : tx
            .select({ n: sql<number>`count(*)::int` })
            .from(refundRequests)
            .where(
              and(
                standing,
                destination.field === 'phone'
                  ? sql`right(regexp_replace(COALESCE(${refundRequests.payoutDetails}->>'phone', ''), '\\D', '', 'g'), 9) = ${destination.value}`
                  : sql`regexp_replace(COALESCE(${refundRequests.payoutDetails}->>'accountNumber', ''), '\\s', '', 'g') = ${destination.value}`,
              ),
            ),
    ]);
    return {
      customer: { count: customer[0]?.n ?? 0, cents: toCents(customer[0]?.cents ?? '0') },
      destination: atDestination === null ? null : { count: atDestination[0]?.n ?? 0 },
      requester: { count: requester[0]?.n ?? 0, cents: toCents(requester[0]?.cents ?? '0') },
    };
  }
}
