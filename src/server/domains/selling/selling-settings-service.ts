import { and, eq, inArray } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { branches, sellingDocumentSettings } from '@/server/db/drizzle/schema';
import type { Actor } from '@/server/kernel/context';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { ReasonCodes, ReasonInput } from '@/server/kernel/reason-codes/service';
import { checkSellingInput, defOf, isSellingType, manualDiscountOffered, readSellingSettings, SELLING_TYPE_DEFS, type SellingSettings, type SellingType } from './selling-documents';

export class SellingSettingsError extends Error {}

export interface SellingTypeView {
  type: SellingType;
  label: string;
  description: string;
  settings: SellingSettings;
  /** Changed from the built-in behaviour. */
  configured: boolean;
  version: number;
  /** The branches named for the manual discount, by name, so the screen can show them. */
  branches: { id: string; name: string }[];
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
    const settings = new Map(SELLING_TYPE_DEFS.map((d) => [d.type, readSellingSettings(d.type, byType.get(d.type)?.config)]));
    const named = await this.branchNames(companyId, [...settings.values()].flatMap((s) => s.manualDiscountBranches));
    return SELLING_TYPE_DEFS.map((d) => {
      const row = byType.get(d.type);
      const s = settings.get(d.type) ?? d.defaults;
      return { type: d.type, label: d.label, description: d.description, settings: s, configured: row !== undefined, version: row?.version ?? 0, branches: s.manualDiscountBranches.flatMap((id) => { const name = named.get(id); return name === undefined ? [] : [{ id, name }]; }) };
    });
  }

  /** Names for branch ids of this company (one query); an id that is not one of its branches has no name. */
  private async branchNames(companyId: string, ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db.select({ id: branches.id, name: branches.name }).from(branches).where(and(eq(branches.companyId, companyId), inArray(branches.id, [...new Set(ids)])));
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  /** Whether staff may type a discount at this branch under this type's setting (the person's permission is checked by the caller). A branch left blank is the company's default branch. */
  async manualDiscountOffered(companyId: string, type: SellingType, branchId: string | null): Promise<boolean> {
    return manualDiscountOffered(await this.get(companyId, type), branchId);
  }

  async save(companyId: string, typeRaw: unknown, raw: unknown, actor: Actor, reason: Why): Promise<void> {
    if (!isSellingType(typeRaw)) throw new SellingSettingsError('That is not a selling document that can be set up.');
    const checked = checkSellingInput(typeRaw, raw);
    if (!checked.ok) throw new SellingSettingsError(checked.error);
    const known = await this.branchNames(companyId, checked.settings.manualDiscountBranches);
    if (known.size !== checked.settings.manualDiscountBranches.length) throw new SellingSettingsError('One of the branches could not be found. Choose the branches again.');
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
