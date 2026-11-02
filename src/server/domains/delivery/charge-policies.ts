import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { branches, chargePolicies, chargePolicyRates, customerGroups, deliveryZones, type ChargePolicyRateRow, type ChargePolicyRow } from '@/server/db/drizzle/schema';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { isUniqueViolation } from '@/server/domains/settings/errors';
import { DeliveryError } from './errors';
import { wouldTie, type PolicyHeader } from './domain/select';
import { validatePolicy } from './domain/validate';
import type { PolicyInput } from './domain/read';
import type { ChargePolicyDef } from './domain/types';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];
interface Actor {
  id: string;
}

const n = (v: string | null): number | null => (v === null ? null : Number(v));
const text = (v: number | null): string | null => (v === null ? null : String(v));

/** A stored policy and its fees, as the engine reads them. */
export function toDef(row: ChargePolicyRow, rates: readonly ChargePolicyRateRow[]): ChargePolicyDef {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    version: row.version,
    method: row.method,
    currency: row.currency,
    distanceBasis: row.distanceBasis,
    maxRangeKm: n(row.maxRangeKm),
    perMinute: Number(row.perMinute),
    includedKg: n(row.includedKg),
    perExtraKg: Number(row.perExtraKg),
    maxWeightKg: n(row.maxWeightKg),
    minCharge: n(row.minCharge),
    maxCharge: n(row.maxCharge),
    roundTo: Number(row.roundTo),
    roundMode: row.roundMode,
    rates: rates.map((r) => ({ zoneId: r.zoneId, fromKg: Number(r.fromKg), toKg: n(r.toKg), fee: Number(r.fee), perExtraKg: Number(r.perExtraKg) })),
    bands: row.bands,
    tiers: row.tiers,
    surcharges: row.surcharges,
  };
}

/** What choosing a policy needs from a stored one. */
export function toHeader(row: ChargePolicyRow): PolicyHeader {
  return { id: row.id, code: row.code, currency: row.currency, status: row.status, priority: row.priority, validFrom: row.validFrom, validTo: row.validTo, scopes: row.scopes };
}

/** The policy as the engine will read it once saved, for checking it before it is. */
function defOf(code: string, version: number, input: PolicyInput): ChargePolicyDef {
  return {
    id: 'draft',
    code,
    name: input.name,
    version,
    method: input.method,
    currency: input.currency,
    distanceBasis: input.distanceBasis,
    maxRangeKm: input.maxRangeKm,
    perMinute: input.perMinute,
    includedKg: input.includedKg,
    perExtraKg: input.perExtraKg,
    maxWeightKg: input.maxWeightKg,
    minCharge: input.minCharge,
    maxCharge: input.maxCharge,
    roundTo: input.roundTo,
    roundMode: input.roundMode,
    rates: input.rates,
    bands: input.bands,
    tiers: input.tiers,
    surcharges: input.surcharges,
  };
}

const headerValues = (input: PolicyInput) => ({
  name: input.name,
  description: input.description,
  method: input.method,
  currency: input.currency,
  priority: input.priority,
  validTo: input.validTo,
  scopes: input.scopes,
  distanceBasis: input.distanceBasis,
  maxRangeKm: text(input.maxRangeKm),
  perMinute: String(input.perMinute),
  includedKg: text(input.includedKg),
  perExtraKg: String(input.perExtraKg),
  maxWeightKg: text(input.maxWeightKg),
  minCharge: text(input.minCharge),
  maxCharge: text(input.maxCharge),
  roundTo: String(input.roundTo),
  roundMode: input.roundMode,
  taxRate: String(input.taxRate),
  taxInclusive: input.taxInclusive,
  bands: input.bands,
  tiers: input.tiers,
  surcharges: input.surcharges,
});

/** The first few problems of a policy as one message a person can act on. */
function problems(def: ChargePolicyDef): string | null {
  const issues = validatePolicy(def);
  if (issues.length === 0) return null;
  const shown = issues.slice(0, 4).map((i, k) => `${String(k + 1)}. ${i.message}`);
  return `This policy cannot be saved yet. ${shown.join(' ')}${issues.length > 4 ? ` (and ${String(issues.length - 4)} more)` : ''}`;
}

const reasonOf = (reason: unknown): string => {
  const r = typeof reason === 'string' ? reason.trim() : '';
  if (r.length < 5) throw new DeliveryError('Say why, in a few words, so the change can be explained later.', 'BAD_INPUT');
  return r.slice(0, 300);
};

/**
 * Charge policies and their life: draft, in force, retired. A policy in force is never edited; a change is a new version that goes through
 * the same steps, and putting it in force retires the version it replaces. Every step is company-scoped, in one transaction with its
 * decision-log entry, and a policy cannot go live unless `validatePolicy` finds it sound and nothing else in force would tie with it.
 */
export class ChargePolicies {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
  ) {}

  /** A policy and its fees, only if it is this company's. */
  async get(companyId: string, id: string): Promise<{ row: ChargePolicyRow; rates: ChargePolicyRateRow[]; def: ChargePolicyDef } | null> {
    const [row] = await this.db.select().from(chargePolicies).where(and(eq(chargePolicies.id, id), eq(chargePolicies.companyId, companyId)));
    if (row === undefined) return null;
    const rates = await this.db.select().from(chargePolicyRates).where(eq(chargePolicyRates.policyId, id)).orderBy(asc(chargePolicyRates.zoneId), asc(chargePolicyRates.fromKg));
    return { row, rates, def: toDef(row, rates) };
  }

  /** Every policy in force, with its fees, in two reads however many there are. */
  async inForce(companyId: string): Promise<{ row: ChargePolicyRow; def: ChargePolicyDef }[]> {
    const rows = await this.db.select().from(chargePolicies).where(and(eq(chargePolicies.companyId, companyId), eq(chargePolicies.status, 'in_force')));
    if (rows.length === 0) return [];
    const rates = await this.db.select().from(chargePolicyRates).where(inArray(chargePolicyRates.policyId, rows.map((r) => r.id)));
    const byPolicy = new Map<string, ChargePolicyRateRow[]>();
    for (const r of rates) byPolicy.set(r.policyId, [...(byPolicy.get(r.policyId) ?? []), r]);
    return rows.map((row) => ({ row, def: toDef(row, byPolicy.get(row.id) ?? []) }));
  }

  async createDraft(companyId: string, actor: Actor, codeInput: string, input: PolicyInput): Promise<ChargePolicyRow> {
    const code = codeInput.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9._-]{0,29}$/.test(code)) throw new DeliveryError('A code is up to 30 letters, numbers, dots, dashes or underscores.', 'BAD_INPUT');
    const bad = problems(defOf(code, 1, input));
    if (bad !== null) throw new DeliveryError(bad, 'BAD_INPUT');
    try {
      return await this.db.transaction(async (tx) => {
        await this.checkReferences(tx, companyId, input, false);
        const [row] = await tx.insert(chargePolicies).values({ companyId, code, version: 1, status: 'draft', createdBy: actor.id, validFrom: input.validFrom ?? new Date(), ...headerValues(input) }).returning();
        if (row === undefined) throw new Error('The policy was not saved.');
        await this.saveRates(tx, row.id, input);
        await this.log(tx, companyId, actor, row.id, 'delivery.charge_policy_drafted', null, `${code} v1`, null, { method: input.method });
        return row;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new DeliveryError(`A policy with the code ${code} already exists. Open it and make a new version instead.`, 'DUPLICATE');
      throw error;
    }
  }

  /** Replaces a draft, if it is still the revision the person opened. */
  async saveDraft(companyId: string, actor: Actor, id: string, input: PolicyInput, expectedRevision: number): Promise<ChargePolicyRow> {
    return await this.db.transaction(async (tx) => {
      const before = await this.lock(tx, companyId, id);
      if (before.status !== 'draft') throw new DeliveryError('Only a draft can be changed. Make a new version to change a policy that is in force or retired.', 'NOT_ALLOWED');
      if (before.revision !== expectedRevision) throw new DeliveryError('Someone else changed this draft while you were editing. Reload it and make your change again.', 'CONFLICT');
      const bad = problems(defOf(before.code, before.version, input));
      if (bad !== null) throw new DeliveryError(bad, 'BAD_INPUT');
      await this.checkReferences(tx, companyId, input, false);
      const [row] = await tx
        .update(chargePolicies)
        .set({ ...headerValues(input), validFrom: input.validFrom ?? before.validFrom, revision: sql`${chargePolicies.revision} + 1`, updatedAt: sql`now()` })
        .where(eq(chargePolicies.id, id))
        .returning();
      if (row === undefined) throw new Error('The policy was not saved.');
      await tx.delete(chargePolicyRates).where(eq(chargePolicyRates.policyId, id));
      await this.saveRates(tx, id, input);
      await this.log(tx, companyId, actor, id, 'delivery.charge_policy_edited', `${before.code} v${String(before.version)} r${String(before.revision)}`, `${row.code} v${String(row.version)} r${String(row.revision)}`, null, {});
      return row;
    });
  }

  /** Copies a policy that is in force or retired into a draft of the next version. */
  async newVersion(companyId: string, actor: Actor, id: string): Promise<ChargePolicyRow> {
    try {
      return await this.db.transaction(async (tx) => {
        const from = await this.lock(tx, companyId, id);
        if (from.status === 'draft') throw new DeliveryError('This is already a draft. Change it directly.', 'NOT_ALLOWED');
        const [newest] = await tx.select({ version: sql<number>`max(${chargePolicies.version})::int` }).from(chargePolicies).where(and(eq(chargePolicies.companyId, companyId), eq(chargePolicies.code, from.code)));
        const rates = await tx.select().from(chargePolicyRates).where(eq(chargePolicyRates.policyId, id));
        const next = (newest?.version ?? from.version) + 1;
        const [row] = await tx
          .insert(chargePolicies)
          .values({
            companyId, code: from.code, version: next, status: 'draft', createdBy: actor.id, name: from.name, description: from.description, method: from.method, currency: from.currency, priority: from.priority, validFrom: new Date(), validTo: null, scopes: from.scopes,
            distanceBasis: from.distanceBasis, maxRangeKm: from.maxRangeKm, perMinute: from.perMinute, includedKg: from.includedKg, perExtraKg: from.perExtraKg, maxWeightKg: from.maxWeightKg, minCharge: from.minCharge, maxCharge: from.maxCharge, roundTo: from.roundTo, roundMode: from.roundMode, taxRate: from.taxRate, taxInclusive: from.taxInclusive, bands: from.bands, tiers: from.tiers, surcharges: from.surcharges,
          })
          .returning();
        if (row === undefined) throw new Error('The policy was not saved.');
        if (rates.length > 0) await tx.insert(chargePolicyRates).values(rates.map((r) => ({ policyId: row.id, zoneId: r.zoneId, fromKg: r.fromKg, toKg: r.toKg, fee: r.fee, perExtraKg: r.perExtraKg })));
        await this.log(tx, companyId, actor, row.id, 'delivery.charge_policy_versioned', `${from.code} v${String(from.version)}`, `${row.code} v${String(row.version)}`, null, {});
        return row;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new DeliveryError('This policy already has a draft. Open it and change that instead.', 'DUPLICATE');
      throw error;
    }
  }

  async deleteDraft(companyId: string, actor: Actor, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const row = await this.lock(tx, companyId, id);
      if (row.status !== 'draft') throw new DeliveryError('Only a draft can be deleted. A policy that has been in force is kept so past charges can be explained; retire it instead.', 'NOT_ALLOWED');
      await tx.delete(chargePolicies).where(eq(chargePolicies.id, id));
      await this.log(tx, companyId, actor, id, 'delivery.charge_policy_discarded', `${row.code} v${String(row.version)}`, null, null, {});
    });
  }

  /**
   * Puts a draft in force, if it is sound, its zones are in use, and nothing else in force would tie with it. The version it replaces is
   * retired in the same step, so there is never a moment with two versions of one policy in force or none.
   */
  async activate(companyId: string, actor: Actor, id: string, reasonInput: unknown): Promise<ChargePolicyRow> {
    const reason = reasonOf(reasonInput);
    try {
      return await this.db.transaction(async (tx) => {
        const draft = await this.lock(tx, companyId, id);
        if (draft.status !== 'draft') throw new DeliveryError('Only a draft can be put in force.', 'NOT_ALLOWED');
        const rates = await tx.select().from(chargePolicyRates).where(eq(chargePolicyRates.policyId, id));
        const bad = problems(toDef(draft, rates));
        if (bad !== null) throw new DeliveryError(bad, 'BAD_INPUT');
        await this.checkReferences(tx, companyId, { scopes: draft.scopes, rates: rates.map((r) => ({ zoneId: r.zoneId })) }, true);
        const others = await tx.select().from(chargePolicies).where(and(eq(chargePolicies.companyId, companyId), eq(chargePolicies.status, 'in_force')));
        for (const other of others.filter((o) => o.code !== draft.code)) {
          if (wouldTie(toHeader(draft), toHeader(other))) throw new DeliveryError(`${other.code} (version ${String(other.version)}) is in force with the same priority, the same kind of scope and overlapping dates, so a delivery could be priced by either. Change the priority, who it is for, or the dates.`, 'CONFLICT');
        }
        const previous = others.find((o) => o.code === draft.code);
        if (previous !== undefined) {
          await tx.update(chargePolicies).set({ status: 'retired', retiredAt: sql`now()`, retiredBy: actor.id, updatedAt: sql`now()` }).where(eq(chargePolicies.id, previous.id));
          await this.log(tx, companyId, actor, previous.id, 'delivery.charge_policy_replaced', `${previous.code} v${String(previous.version)} in force`, `${previous.code} v${String(previous.version)} retired`, reason, { replacedBy: draft.id });
        }
        const [row] = await tx.update(chargePolicies).set({ status: 'in_force', activatedAt: sql`now()`, activatedBy: actor.id, updatedAt: sql`now()` }).where(eq(chargePolicies.id, id)).returning();
        if (row === undefined) throw new Error('The policy was not saved.');
        await this.log(tx, companyId, actor, id, 'delivery.charge_policy_in_force', `${draft.code} v${String(draft.version)} draft`, `${draft.code} v${String(draft.version)} in force`, reason, { method: draft.method, replaces: previous?.id ?? null });
        return row;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new DeliveryError('Another version of this policy was put in force at the same moment. Reload and check which one you want.', 'CONFLICT');
      throw error;
    }
  }

  async retire(companyId: string, actor: Actor, id: string, reasonInput: unknown): Promise<ChargePolicyRow> {
    const reason = reasonOf(reasonInput);
    return await this.db.transaction(async (tx) => {
      const before = await this.lock(tx, companyId, id);
      if (before.status !== 'in_force') throw new DeliveryError('Only a policy in force can be retired.', 'NOT_ALLOWED');
      const [row] = await tx.update(chargePolicies).set({ status: 'retired', retiredAt: sql`now()`, retiredBy: actor.id, updatedAt: sql`now()` }).where(eq(chargePolicies.id, id)).returning();
      if (row === undefined) throw new Error('The policy was not saved.');
      await this.log(tx, companyId, actor, id, 'delivery.charge_policy_retired', `${before.code} v${String(before.version)} in force`, `${before.code} v${String(before.version)} retired`, reason, {});
      return row;
    });
  }

  private async lock(tx: Tx, companyId: string, id: string): Promise<ChargePolicyRow> {
    const [row] = await tx.select().from(chargePolicies).where(and(eq(chargePolicies.id, id), eq(chargePolicies.companyId, companyId))).for('update');
    if (row === undefined) throw new DeliveryError('That policy could not be found.', 'NOT_FOUND');
    return row;
  }

  private async saveRates(tx: Tx, policyId: string, input: Pick<PolicyInput, 'rates'>): Promise<void> {
    for (let start = 0; start < input.rates.length; start += 500) {
      const chunk = input.rates.slice(start, start + 500);
      await tx.insert(chargePolicyRates).values(chunk.map((r) => ({ policyId, zoneId: r.zoneId, fromKg: String(r.fromKg), toKg: text(r.toKg), fee: String(r.fee), perExtraKg: String(r.perExtraKg) })));
    }
  }

  /** The zones, branches and customer groups a policy names must be this company's; to go live, its zones must also be in use. */
  private async checkReferences(tx: Tx, companyId: string, input: { scopes: PolicyInput['scopes']; rates: readonly { zoneId: string | null }[] }, live: boolean): Promise<void> {
    const zoneIds = [...new Set(input.rates.map((r) => r.zoneId).filter((z): z is string => z !== null))];
    if (zoneIds.length > 0) {
      const found = await tx.select({ id: deliveryZones.id, code: deliveryZones.code, isActive: deliveryZones.isActive }).from(deliveryZones).where(and(eq(deliveryZones.companyId, companyId), inArray(deliveryZones.id, zoneIds)));
      if (found.length !== zoneIds.length) throw new DeliveryError('A fee names a delivery zone that does not exist.', 'BAD_INPUT');
      const stopped = found.filter((z) => !z.isActive);
      if (live && stopped.length > 0) throw new DeliveryError(`The zone ${stopped.map((z) => z.code).join(', ')} is stopped. Restart it or remove its fees before putting this policy in force.`, 'NOT_ALLOWED');
    }
    for (const [dimension, table, idColumn, companyColumn] of [['branch', branches, branches.id, branches.companyId], ['customer_group', customerGroups, customerGroups.id, customerGroups.companyId]] as const) {
      const ids = [...new Set(input.scopes[dimension]?.values ?? [])];
      if (ids.length === 0) continue;
      const valid = ids.filter((v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v));
      const found = valid.length === 0 ? [] : await tx.select({ id: idColumn }).from(table).where(and(eq(companyColumn, companyId), inArray(idColumn, valid)));
      if (found.length !== ids.length) throw new DeliveryError(`Who the policy is for names a ${dimension === 'branch' ? 'branch' : 'customer group'} that does not exist.`, 'BAD_INPUT');
    }
  }

  private async log(tx: Tx, companyId: string, actor: Actor, id: string, action: string, from: string | null, to: string | null, reason: string | null, outcome: Record<string, unknown>): Promise<void> {
    await this.decisions.record({ companyId, subject: { type: 'charge_policy', id }, action, actor: { type: 'user', id: actor.id }, ...(from === null ? {} : { from }), ...(to === null ? {} : { to }), ...(reason === null ? {} : { reason: { text: reason } }), outcome }, tx);
  }
}

