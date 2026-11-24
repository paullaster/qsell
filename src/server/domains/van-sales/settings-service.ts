import { eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { vanSalesSettings } from '@/server/db/drizzle/schema';
import type { Actor } from '@/server/kernel/context';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { ReasonCodes, ReasonInput } from '@/server/kernel/reason-codes/service';
import { readSettings, VAN_SALES_DEFAULTS, type VanSalesSettings } from '@/lib/van-sales/settings';

import { VanSalesError } from './errors';

export { VanSalesError };

export interface VanSalesScreen {
  settings: VanSalesSettings;
  version: number;
  updatedBy: string | null;
  updatedAt: string | null;
}

/**
 * Which of the two modes (van sell, pre-sell) the company uses and the rules every van day follows (docs/architecture/van-sales.md §16).
 * Off until switched on; changed only with its own permission, a reason, and the version the person was looking at, so two people
 * editing at once cannot overwrite each other. Every change is in the decision log.
 */
export class VanSalesSettingsService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly reasons: ReasonCodes,
  ) {}

  async screen(companyId: string): Promise<VanSalesScreen> {
    const [row] = await this.db.select().from(vanSalesSettings).where(eq(vanSalesSettings.companyId, companyId)).limit(1);
    if (row === undefined) return { settings: { ...VAN_SALES_DEFAULTS }, version: 0, updatedBy: null, updatedAt: null };
    return {
      settings: {
        vanSell: row.vanSell,
        preSell: row.preSell,
        offRoute: row.offRoute as VanSalesSettings['offRoute'],
        overnightStock: row.overnightStock,
        shortage: row.shortage as VanSalesSettings['shortage'],
        shortageApprovalAbove: Number(row.shortageApprovalAbove),
        position: row.position as VanSalesSettings['position'],
        nearMetres: row.nearMetres,
      },
      version: row.version,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** The settings alone, for the services that obey them. */
  async current(companyId: string): Promise<VanSalesSettings> {
    return (await this.screen(companyId)).settings;
  }

  async save(companyId: string, actor: Actor, raw: unknown, expectedVersion: unknown, reason: ReasonInput): Promise<VanSalesScreen> {
    const read = readSettings(raw);
    if (!read.ok) throw new VanSalesError(read.error);
    if (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion) || expectedVersion < 0) throw new VanSalesError('Reload the page and try again: the version of the settings is missing.');
    const why = await this.reasons.require(companyId, reason, 'van_sales_configuration');
    const next = read.settings;
    await this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(vanSalesSettings).where(eq(vanSalesSettings.companyId, companyId)).limit(1).for('update');
      const current = before?.version ?? 0;
      if (current !== expectedVersion) throw new VanSalesError('Someone else changed these settings while you were looking at them. Reload the page to see the latest and make your change again.');
      const values = {
        vanSell: next.vanSell,
        preSell: next.preSell,
        offRoute: next.offRoute,
        overnightStock: next.overnightStock,
        shortage: next.shortage,
        shortageApprovalAbove: next.shortageApprovalAbove.toFixed(2),
        position: next.position,
        nearMetres: next.nearMetres,
        updatedBy: actor.id ?? 'system',
        updatedAt: new Date(),
      };
      if (before === undefined) await tx.insert(vanSalesSettings).values({ companyId, ...values });
      else await tx.update(vanSalesSettings).set({ ...values, version: before.version + 1 }).where(eq(vanSalesSettings.companyId, companyId));
      const was: VanSalesSettings = before === undefined ? VAN_SALES_DEFAULTS : { vanSell: before.vanSell, preSell: before.preSell, offRoute: before.offRoute as VanSalesSettings['offRoute'], overnightStock: before.overnightStock, shortage: before.shortage as VanSalesSettings['shortage'], shortageApprovalAbove: Number(before.shortageApprovalAbove), position: before.position as VanSalesSettings['position'], nearMetres: before.nearMetres };
      await this.decisions.record({ companyId, actor, subject: { type: 'van_sales_settings', id: companyId }, action: 'van_sales_settings.changed', reason: why, inputs: { ...was }, outcome: { ...next } }, tx);
    });
    return await this.screen(companyId);
  }
}
