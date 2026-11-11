import { and, asc, eq, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { deliveryRuns, deliveryVehicles } from '@/server/db/drizzle/schema';
import { checkVehicle, type VehicleLimits } from '@/lib/delivery-vehicle';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { DocActor, DocRefusal, DocResult } from './documents';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

export interface VehicleView extends VehicleLimits {
  id: string;
  name: string;
  isActive: boolean;
  version: number;
  /** Runs that are planned or on the road in it now: a vehicle in use can still be changed, and the limits apply to the stops added from then on. */
  runsInUse: number;
}

const fail = (reason: DocRefusal, message: string): { ok: false; reason: DocRefusal; message: string } => ({ ok: false, reason, message });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_TAKEN = 'delivery_vehicles_company_name_uidx';

/** A second vehicle with a name already in use: the database refuses it, and the driver names the rule under either spelling. */
const isNameTaken = (e: unknown): boolean => {
  const cause = typeof e === 'object' && e !== null && 'cause' in e ? e.cause : e;
  if (typeof cause !== 'object' || cause === null) return false;
  const named = cause as { constraint?: unknown; constraint_name?: unknown };
  return named.constraint === NAME_TAKEN || named.constraint_name === NAME_TAKEN;
};

/**
 * The fleet's vehicles and what a run may carry in each. A vehicle is stopped, never removed: runs point at it and keep its name as it was.
 * Changes use a version and are written to the decision log.
 */
export class DeliveryVehicles {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private view(v: typeof deliveryVehicles.$inferSelect, runsInUse: number): VehicleView {
    return { id: v.id, name: v.name, maxWeightKg: v.maxWeightKg, maxStops: v.maxStops, isActive: v.isActive, version: v.version, runsInUse };
  }

  /** Every vehicle of the company, those in use first. A fleet is a handful of vehicles, so this is one read with the run counts grouped in. */
  async list(companyId: string): Promise<VehicleView[]> {
    const rows = await this.db.select().from(deliveryVehicles).where(eq(deliveryVehicles.companyId, companyId)).orderBy(sql`${deliveryVehicles.isActive} DESC`, asc(deliveryVehicles.name)).limit(500);
    if (rows.length === 0) return [];
    const counts = await this.db
      .select({ vehicleId: deliveryRuns.vehicleId, n: sql<number>`count(*)::int` })
      .from(deliveryRuns)
      .where(and(eq(deliveryRuns.companyId, companyId), sql`${deliveryRuns.vehicleId} IS NOT NULL`, sql`${deliveryRuns.status} IN ('planned','started')`))
      .groupBy(deliveryRuns.vehicleId);
    const used = new Map(counts.map((c) => [c.vehicleId ?? '', c.n]));
    return rows.map((v) => this.view(v, used.get(v.id) ?? 0));
  }

  /** A vehicle a run can be given: the company's own and still in use. Null otherwise, and the caller says so in words. */
  async usable(tx: Tx | DrizzleDb, companyId: string, id: string): Promise<(VehicleLimits & { id: string; name: string }) | null> {
    if (!UUID.test(id)) return null;
    const [v] = await tx.select().from(deliveryVehicles).where(and(eq(deliveryVehicles.id, id), eq(deliveryVehicles.companyId, companyId), eq(deliveryVehicles.isActive, true)));
    return v === undefined ? null : { id: v.id, name: v.name, maxWeightKg: v.maxWeightKg, maxStops: v.maxStops };
  }

  /** The limits of the vehicle a run goes in, whether or not it is still in use (a run keeps the limits of the vehicle it was given). */
  async limitsOf(tx: Tx | DrizzleDb, companyId: string, id: string): Promise<(VehicleLimits & { name: string }) | null> {
    const [v] = await tx.select().from(deliveryVehicles).where(and(eq(deliveryVehicles.id, id), eq(deliveryVehicles.companyId, companyId)));
    return v === undefined ? null : { name: v.name, maxWeightKg: v.maxWeightKg, maxStops: v.maxStops };
  }

  async create(actor: DocActor, input: Record<string, unknown>): Promise<DocResult<VehicleView>> {
    const checked = checkVehicle(input);
    if (!checked.ok) return fail('bad_input', checked.error);
    try {
      return await this.db.transaction(async (tx) => {
        const [v] = await tx.insert(deliveryVehicles).values({ companyId: actor.companyId, name: checked.name, maxWeightKg: checked.maxWeightKg, maxStops: checked.maxStops, createdBy: actor.userId }).returning();
        if (v === undefined) throw new Error('The vehicle was not saved.');
        await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery_vehicle', id: v.id }, action: 'vehicle.created', actor: { type: 'user', id: actor.userId }, reason: { text: v.name }, inputs: { maxWeightKg: v.maxWeightKg, maxStops: v.maxStops } }, tx);
        return { ok: true as const, data: this.view(v, 0) };
      });
    } catch (e) {
      if (isNameTaken(e)) return fail('conflict', 'A vehicle with that name or plate is already in the list.');
      throw e;
    }
  }

  async update(actor: DocActor, id: string, input: Record<string, unknown>): Promise<DocResult<VehicleView>> {
    const checked = checkVehicle(input);
    if (!checked.ok) return fail('bad_input', checked.error);
    try {
      return await this.db.transaction(async (tx) => {
        const row = await this.locked(tx, actor.companyId, id);
        if (row === null) return fail('not_found', 'That vehicle could not be found.');
        if (input.expectedVersion !== row.version) return fail('conflict', 'Someone else changed this vehicle. Reload to see the latest.');
        const [v] = await tx.update(deliveryVehicles).set({ name: checked.name, maxWeightKg: checked.maxWeightKg, maxStops: checked.maxStops, version: row.version + 1, updatedAt: this.clock() }).where(eq(deliveryVehicles.id, id)).returning();
        if (v === undefined) throw new Error('The vehicle was not saved.');
        await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery_vehicle', id }, action: 'vehicle.changed', actor: { type: 'user', id: actor.userId }, reason: { text: v.name }, inputs: { before: { name: row.name, maxWeightKg: row.maxWeightKg, maxStops: row.maxStops }, after: { name: v.name, maxWeightKg: v.maxWeightKg, maxStops: v.maxStops } } }, tx);
        return { ok: true as const, data: this.view(v, await this.inUse(tx, actor.companyId, id)) };
      });
    } catch (e) {
      if (isNameTaken(e)) return fail('conflict', 'A vehicle with that name or plate is already in the list.');
      throw e;
    }
  }

  /** Stops a vehicle or brings it back. A stopped vehicle cannot be given to a new run; runs already in it carry on. */
  async setActive(actor: DocActor, id: string, input: { isActive: unknown; expectedVersion: unknown }): Promise<DocResult<VehicleView>> {
    if (typeof input.isActive !== 'boolean') return fail('bad_input', 'Say whether the vehicle is in use.');
    const isActive = input.isActive;
    return await this.db.transaction(async (tx) => {
      const row = await this.locked(tx, actor.companyId, id);
      if (row === null) return fail('not_found', 'That vehicle could not be found.');
      if (input.expectedVersion !== row.version) return fail('conflict', 'Someone else changed this vehicle. Reload to see the latest.');
      const [v] = await tx.update(deliveryVehicles).set({ isActive, version: row.version + 1, updatedAt: this.clock() }).where(eq(deliveryVehicles.id, id)).returning();
      if (v === undefined) throw new Error('The vehicle was not saved.');
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery_vehicle', id }, action: isActive ? 'vehicle.resumed' : 'vehicle.stopped', actor: { type: 'user', id: actor.userId }, reason: { text: v.name } }, tx);
      return { ok: true as const, data: this.view(v, await this.inUse(tx, actor.companyId, id)) };
    });
  }

  private async locked(tx: Tx, companyId: string, id: string): Promise<typeof deliveryVehicles.$inferSelect | null> {
    if (!UUID.test(id)) return null;
    const [row] = await tx.select().from(deliveryVehicles).where(and(eq(deliveryVehicles.id, id), eq(deliveryVehicles.companyId, companyId))).for('update');
    return row ?? null;
  }

  private async inUse(tx: Tx, companyId: string, id: string): Promise<number> {
    const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(deliveryRuns).where(and(eq(deliveryRuns.companyId, companyId), eq(deliveryRuns.vehicleId, id), sql`${deliveryRuns.status} IN ('planned','started')`));
    return r?.n ?? 0;
  }
}
