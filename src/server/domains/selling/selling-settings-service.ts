import { and, eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { sellingDocumentSettings } from '@/server/db/drizzle/schema';
import type { Actor } from '@/server/kernel/context';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { ReasonCodes, ReasonInput } from '@/server/kernel/reason-codes/service';
import { checkSellingInput, defOf, isSellingType, readSellingSettings, SELLING_TYPE_DEFS, type SellingSettings, type SellingType } from './selling-documents';

export class SellingSettingsError extends Error {}

export interface SellingTypeView {
  type: SellingType;
  label: string;
  description: string;
  settings: SellingSettings;
  /** Changed from the built-in behaviour. */
  configured: boolean;
  version: number;
}

type Why = ReasonInput;

/** How each selling document type behaves for the company: read by the order writer and the selling screens, changed in Settings. */
export class SellingSettingsService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly reasons: ReasonCodes,
  ) {}

  /** One type's behaviour now; with no saved row, its defaults. */
  async get(companyId: string, type: SellingType): Promise<SellingSettings> {
    const [row] = await this.db.select().from(sellingDocumentSettings).where(and(eq(sellingDocumentSettings.companyId, companyId), eq(sellingDocumentSettings.docType, type))).limit(1);
    return readSellingSettings(type, row?.config);
  }

  /** Every type as the screen shows it. */
  async screen(companyId: string): Promise<SellingTypeView[]> {
    const rows = await this.db.select().from(sellingDocumentSettings).where(eq(sellingDocumentSettings.companyId, companyId));
    const byType = new Map(rows.map((r) => [r.docType, r]));
    return SELLING_TYPE_DEFS.map((d) => {
      const row = byType.get(d.type);
      return { type: d.type, label: d.label, description: d.description, settings: readSellingSettings(d.type, row?.config), configured: row !== undefined, version: row?.version ?? 0 };
    });
  }

  async save(companyId: string, typeRaw: unknown, raw: unknown, actor: Actor, reason: Why): Promise<void> {
    if (!isSellingType(typeRaw)) throw new SellingSettingsError('That is not a selling document that can be set up.');
    const checked = checkSellingInput(typeRaw, raw);
    if (!checked.ok) throw new SellingSettingsError(checked.error);
    const why = await this.reasons.require(companyId, reason, 'selling_configuration');
    const config: Record<string, unknown> = { ...checked.settings };
    await this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(sellingDocumentSettings).where(and(eq(sellingDocumentSettings.companyId, companyId), eq(sellingDocumentSettings.docType, typeRaw))).limit(1).for('update');
      if (before === undefined) await tx.insert(sellingDocumentSettings).values({ companyId, docType: typeRaw, config, version: 1, updatedBy: actor.id ?? 'system' });
      else await tx.update(sellingDocumentSettings).set({ config, version: before.version + 1, updatedBy: actor.id ?? 'system', updatedAt: new Date() }).where(eq(sellingDocumentSettings.id, before.id));
      await this.decisions.record(
        {
          companyId,
          actor,
          subject: { type: 'selling_document', id: typeRaw },
          action: before === undefined ? 'selling.configured' : 'selling.changed',
          reason: why,
          inputs: before === undefined ? {} : { ...readSellingSettings(typeRaw, before.config) },
          outcome: { ...checked.settings },
        },
        tx,
      );
    });
  }

  /** Puts one type back to its built-in behaviour. */
  async reset(companyId: string, typeRaw: unknown, actor: Actor, reason: Why): Promise<void> {
    if (!isSellingType(typeRaw)) throw new SellingSettingsError('That is not a selling document that can be set up.');
    const why = await this.reasons.require(companyId, reason, 'selling_configuration');
    await this.db.transaction(async (tx) => {
      const removed = await tx.delete(sellingDocumentSettings).where(and(eq(sellingDocumentSettings.companyId, companyId), eq(sellingDocumentSettings.docType, typeRaw))).returning({ id: sellingDocumentSettings.id });
      if (removed.length === 0) return;
      await this.decisions.record({ companyId, actor, subject: { type: 'selling_document', id: typeRaw }, action: 'selling.reset', reason: why, inputs: {}, outcome: { ...defOf(typeRaw).defaults } }, tx);
    });
  }
}
