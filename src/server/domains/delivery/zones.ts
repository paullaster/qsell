import { and, asc, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { deliveryZoneAreas, deliveryZones, type DeliveryZoneAreaRow, type DeliveryZoneRow } from '@/server/db/drizzle/schema';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { areaWords, keysOf, resolveZone, type AddressWords, type AreaInput, type ZoneInput, type ZoneMatch } from '@/lib/delivery-zones';
import type { GeoPoint } from '@/lib/geo';
import { isUniqueViolation } from '@/server/domains/settings/errors';
import { DeliveryError } from './errors';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];
interface Actor {
  id: string;
}

export interface AreaSkip {
  words: string;
  /** The zone that already has this area, when it is one of ours. */
  zoneCode: string | null;
  reason: string;
}

const zoneValues = (input: ZoneInput) => ({
  code: input.code,
  name: input.name,
  description: input.description,
  centreLatitude: input.centre?.latitude ?? null,
  centreLongitude: input.centre?.longitude ?? null,
  radiusKm: input.radiusKm === null ? null : input.radiusKm.toFixed(2),
});

/** Why a place was not added, when it already belongs to a zone. */
function alreadyIn(owner: string | null, thisZone: string): string {
  if (owner === null) return 'It is already in a zone.';
  return owner === thisZone ? 'It is already in this zone.' : `It is already in zone ${owner}.`;
}

/** A zone with its coverage circle as numbers, for the rules. */
export interface ZoneForRules {
  id: string;
  code: string;
  name: string;
  centre: GeoPoint | null;
  radiusKm: number | null;
}

const forRules = (z: DeliveryZoneRow): ZoneForRules => ({
  id: z.id,
  code: z.code,
  name: z.name,
  centre: z.centreLatitude === null || z.centreLongitude === null ? null : { latitude: z.centreLatitude, longitude: z.centreLongitude },
  radiusKm: z.radiusKm === null ? null : Number(z.radiusKm),
});

/**
 * Delivery zones and the places that belong to them. A written address reaches a zone through an area, a pin through the zone's
 * coverage circle (`resolve`). Zones are stopped, never deleted; every change is company-scoped, version-checked where two people
 * can edit, and written to the decision log in the same transaction.
 */
export class DeliveryZones {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
  ) {}

  async create(companyId: string, actor: Actor, input: ZoneInput): Promise<DeliveryZoneRow> {
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx.insert(deliveryZones).values({ companyId, ...zoneValues(input) }).returning();
        if (row === undefined) throw new Error('The zone was not saved.');
        await this.log(tx, companyId, actor, row.id, 'delivery.zone_created', null, row.code, { name: row.name });
        return row;
      });
    } catch (error) {
      throw this.friendly(error, input.code);
    }
  }

  /** Changes a zone only if it is still the version the person saw. */
  async update(companyId: string, actor: Actor, id: string, input: ZoneInput, expectedVersion: number): Promise<DeliveryZoneRow> {
    try {
      return await this.db.transaction(async (tx) => {
        const [before] = await tx.select().from(deliveryZones).where(and(eq(deliveryZones.id, id), eq(deliveryZones.companyId, companyId))).for('update');
        if (before === undefined) throw new DeliveryError('That zone could not be found.', 'NOT_FOUND');
        if (before.version !== expectedVersion) throw new DeliveryError('Someone else changed this zone while you were editing. Reload it and make your change again.', 'CONFLICT');
        const [row] = await tx
          .update(deliveryZones)
          .set({ ...zoneValues(input), version: sql`${deliveryZones.version} + 1`, updatedAt: sql`now()` })
          .where(eq(deliveryZones.id, id))
          .returning();
        if (row === undefined) throw new Error('The zone was not saved.');
        await this.log(tx, companyId, actor, id, 'delivery.zone_changed', `${before.code} v${String(before.version)}`, `${row.code} v${String(row.version)}`, { name: row.name });
        return row;
      });
    } catch (error) {
      throw this.friendly(error, input.code);
    }
  }

  async setActive(companyId: string, actor: Actor, id: string, active: boolean): Promise<DeliveryZoneRow> {
    return await this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(deliveryZones).where(and(eq(deliveryZones.id, id), eq(deliveryZones.companyId, companyId))).for('update');
      if (before === undefined) throw new DeliveryError('That zone could not be found.', 'NOT_FOUND');
      if (before.isActive === active) return before;
      const [row] = await tx.update(deliveryZones).set({ isActive: active, version: sql`${deliveryZones.version} + 1`, updatedAt: sql`now()` }).where(eq(deliveryZones.id, id)).returning();
      if (row === undefined) throw new Error('The zone was not saved.');
      await this.log(tx, companyId, actor, id, active ? 'delivery.zone_restarted' : 'delivery.zone_stopped', before.isActive ? 'in use' : 'stopped', active ? 'in use' : 'stopped', { code: before.code });
      return row;
    });
  }

  /**
   * Adds places to a zone, many at once. A place that is already in a zone (this one or another) is skipped and said so: one set of
   * words belongs to one zone, so a written address has one answer. Everything is checked and written together.
   */
  async addAreas(companyId: string, actor: Actor, zoneId: string, areas: readonly AreaInput[]): Promise<{ added: number; skipped: AreaSkip[] }> {
    if (areas.length === 0) throw new DeliveryError('There is no area to add.', 'BAD_INPUT');
    if (areas.length > 200) throw new DeliveryError('Add at most 200 areas at a time.', 'BAD_INPUT');
    return await this.db.transaction(async (tx) => {
      const [zone] = await tx.select().from(deliveryZones).where(and(eq(deliveryZones.id, zoneId), eq(deliveryZones.companyId, companyId))).for('update');
      if (zone === undefined) throw new DeliveryError('That zone could not be found.', 'NOT_FOUND');
      if (!zone.isActive) throw new DeliveryError('This zone is stopped. Restart it to add places.', 'NOT_ALLOWED');
      const inserted = await tx
        .insert(deliveryZoneAreas)
        .values(areas.map((a) => ({ companyId, zoneId, county: a.county, town: a.town, area: a.area, countyKey: a.countyKey, townKey: a.townKey, areaKey: a.areaKey })))
        .onConflictDoNothing()
        .returning({ countyKey: deliveryZoneAreas.countyKey, townKey: deliveryZoneAreas.townKey, areaKey: deliveryZoneAreas.areaKey });
      const done = new Set(inserted.map((r) => `${r.countyKey}|${r.townKey}|${r.areaKey}`));
      const left = areas.filter((a) => !done.has(`${a.countyKey}|${a.townKey}|${a.areaKey}`));
      const skipped: AreaSkip[] = [];
      if (left.length > 0) {
        const owners = await tx
          .select({ countyKey: deliveryZoneAreas.countyKey, townKey: deliveryZoneAreas.townKey, areaKey: deliveryZoneAreas.areaKey, code: deliveryZones.code })
          .from(deliveryZoneAreas)
          .innerJoin(deliveryZones, eq(deliveryZones.id, deliveryZoneAreas.zoneId))
          .where(and(eq(deliveryZoneAreas.companyId, companyId), inArray(deliveryZoneAreas.countyKey, [...new Set(left.map((a) => a.countyKey))]), inArray(deliveryZoneAreas.townKey, [...new Set(left.map((a) => a.townKey))]), inArray(deliveryZoneAreas.areaKey, [...new Set(left.map((a) => a.areaKey))])));
        const ownerOf = new Map(owners.map((o) => [`${o.countyKey}|${o.townKey}|${o.areaKey}`, o.code]));
        for (const a of left) {
          const code = ownerOf.get(`${a.countyKey}|${a.townKey}|${a.areaKey}`) ?? null;
          skipped.push({ words: areaWords(a), zoneCode: code, reason: alreadyIn(code, zone.code) });
        }
      }
      if (inserted.length > 0) await this.log(tx, companyId, actor, zoneId, 'delivery.zone_areas_added', null, String(inserted.length), { code: zone.code, added: inserted.length, skipped: skipped.length });
      return { added: inserted.length, skipped };
    });
  }

  async removeArea(companyId: string, actor: Actor, areaId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [gone] = await tx
        .delete(deliveryZoneAreas)
        .where(and(eq(deliveryZoneAreas.id, areaId), eq(deliveryZoneAreas.companyId, companyId)))
        .returning();
      if (gone === undefined) throw new DeliveryError('That area could not be found.', 'NOT_FOUND');
      await this.log(tx, companyId, actor, gone.zoneId, 'delivery.zone_area_removed', areaWords(gone), null, {});
    });
  }

  /** One page of a zone's places in a stable order. */
  async areasPage(companyId: string, zoneId: string, after: string | null, limit: number): Promise<{ rows: DeliveryZoneAreaRow[]; next: string | null }> {
    const rows = await this.db
      .select()
      .from(deliveryZoneAreas)
      .where(and(eq(deliveryZoneAreas.companyId, companyId), eq(deliveryZoneAreas.zoneId, zoneId), after === null ? undefined : gt(deliveryZoneAreas.id, after)))
      .orderBy(asc(deliveryZoneAreas.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    return { rows: page, next: rows.length > limit ? (page.at(-1)?.id ?? null) : null };
  }

  /**
   * The zone a delivery goes to, from a written address and/or a pin. At most eight area rows can cover one address (each of the
   * three words is either its own value or empty), so the lookup is one indexed read; the circles are the few zones that have one.
   */
  async resolve(companyId: string, input: { address?: AddressWords; pin?: GeoPoint | null }): Promise<ZoneMatch<ZoneForRules>> {
    const circles = await this.db.select().from(deliveryZones).where(and(eq(deliveryZones.companyId, companyId), eq(deliveryZones.isActive, true), isNotNull(deliveryZones.radiusKm)));
    const zones = circles.map(forRules);
    const address = input.address;
    let areas: Parameters<typeof resolveZone<ZoneForRules>>[0]['areas'] = [];
    if (address !== undefined) {
      const keys = keysOf(address);
      const rows = await this.db
        .select({ a: deliveryZoneAreas, z: deliveryZones })
        .from(deliveryZoneAreas)
        .innerJoin(deliveryZones, eq(deliveryZones.id, deliveryZoneAreas.zoneId))
        .where(and(eq(deliveryZoneAreas.companyId, companyId), eq(deliveryZones.isActive, true), inArray(deliveryZoneAreas.countyKey, ['', keys.countyKey]), inArray(deliveryZoneAreas.townKey, ['', keys.townKey]), inArray(deliveryZoneAreas.areaKey, ['', keys.areaKey])));
      areas = rows.map(({ a, z }) => ({ id: a.id, zoneId: a.zoneId, countyKey: a.countyKey, townKey: a.townKey, areaKey: a.areaKey, zone: forRules(z) }));
    }
    return resolveZone({ zones, areas, ...(address === undefined ? {} : { address }), ...(input.pin === undefined ? {} : { pin: input.pin }) });
  }

  private friendly(error: unknown, code: string): unknown {
    if (isUniqueViolation(error)) return new DeliveryError(`A zone with the code ${code} already exists.`, 'DUPLICATE');
    return error;
  }

  private async log(tx: Tx, companyId: string, actor: Actor, id: string, action: string, from: string | null, to: string | null, outcome: Record<string, unknown>): Promise<void> {
    await this.decisions.record({ companyId, subject: { type: 'delivery_zone', id }, action, actor: { type: 'user', id: actor.id }, ...(from === null ? {} : { from }), ...(to === null ? {} : { to }), outcome }, tx);
  }
}
