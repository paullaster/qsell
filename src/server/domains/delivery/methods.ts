import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { branches, deliveryMethods, type DeliveryMethodRow } from '@/server/db/drizzle/schema';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { DeliveryMethod, MethodSettings } from '@/lib/delivery-methods';
import { DeliveryError } from './errors';

const stateWords = (method: string, on: boolean): string => `${method} ${on ? 'on' : 'off'}`;

/** Which ways of getting an order to the customer each branch offers. One row per branch and method; changes are logged. */
export class DeliveryMethods {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
  ) {}

  /** The methods of these branches in one read (never one query per branch). */
  async forBranches(companyId: string, branchIds: readonly string[]): Promise<Map<string, DeliveryMethodRow[]>> {
    const byBranch = new Map<string, DeliveryMethodRow[]>();
    if (branchIds.length === 0) return byBranch;
    const rows = await this.db.select().from(deliveryMethods).where(and(eq(deliveryMethods.companyId, companyId), inArray(deliveryMethods.branchId, [...branchIds])));
    for (const row of rows) byBranch.set(row.branchId, [...(byBranch.get(row.branchId) ?? []), row]);
    return byBranch;
  }

  /** The methods a branch offers now. */
  async offered(companyId: string, branchId: string): Promise<DeliveryMethodRow[]> {
    return await this.db.select().from(deliveryMethods).where(and(eq(deliveryMethods.companyId, companyId), eq(deliveryMethods.branchId, branchId), eq(deliveryMethods.isActive, true)));
  }

  async set(companyId: string, actor: { id: string }, branchId: string, method: DeliveryMethod, settings: MethodSettings): Promise<DeliveryMethodRow> {
    return await this.db.transaction(async (tx) => {
      const [branch] = await tx.select({ id: branches.id, code: branches.code }).from(branches).where(and(eq(branches.id, branchId), eq(branches.companyId, companyId)));
      if (branch === undefined) throw new DeliveryError('That branch does not exist.', 'NOT_FOUND');
      const [before] = await tx.select().from(deliveryMethods).where(and(eq(deliveryMethods.branchId, branchId), eq(deliveryMethods.method, method))).for('update');
      const [row] = await tx
        .insert(deliveryMethods)
        .values({ companyId, branchId, method, isActive: settings.isActive, leadTimeMinutes: settings.leadTimeMinutes, note: settings.note })
        .onConflictDoUpdate({ target: [deliveryMethods.branchId, deliveryMethods.method], set: { isActive: settings.isActive, leadTimeMinutes: settings.leadTimeMinutes, note: settings.note, updatedAt: sql`now()` } })
        .returning();
      if (row === undefined) throw new Error('The method was not saved.');
      const unchanged = before?.isActive === row.isActive && before.leadTimeMinutes === row.leadTimeMinutes && before.note === row.note;
      if (!unchanged) {
        await this.decisions.record(
          {
            companyId,
            subject: { type: 'branch', id: branchId },
            action: 'delivery.method_changed',
            actor: { type: 'user', id: actor.id },
            from: before === undefined ? 'not offered' : stateWords(method, before.isActive),
            to: stateWords(method, row.isActive),
            outcome: { branch: branch.code, method, leadTimeMinutes: row.leadTimeMinutes },
          },
          tx,
        );
      }
      return row;
    });
  }
}
