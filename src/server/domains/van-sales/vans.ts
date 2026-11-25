import { and, asc, eq, ilike, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { bankAccounts, branches, deliveryVehicles, registers, salesRoutes, shifts, stockBalances, stockLocations, vans } from '@/server/db/drizzle/schema';
import type { Actor } from '@/server/kernel/context';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { locationCodeFor, readReason, readVan, type VanInput, isId } from '@/lib/van-sales/people';
import { afterCursor, matching, PAGE_SIZE, pageOf, searchText, type PageInput } from '@/server/domains/settings/paging';
import { constraintOf, VanSalesError } from './errors';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

/** The sales channel a van's stock is sold to. No shop, quote or warehouse channel lists it, so van stock is never promised to anyone else. */
export const VAN_CHANNEL = 'van_sale';

export interface VanView {
  id: string;
  name: string;
  branchId: string;
  branchName: string;
  locationId: string;
  locationCode: string;
  registerId: string;
  vehicleId: string | null;
  vehicleName: string | null;
  cashAccountId: string | null;
  cashAccountName: string | null;
  maxCash: number | null;
  status: 'active' | 'stopped';
  statusReason: string | null;
  version: number;
  /** Products with stock on the van, or promised from it. */
  productsOnVan: number;
  /** The van's till has a shift open. */
  shiftOpen: boolean;
}

export type VanFilter = 'active' | 'stopped' | 'all';
export interface VanPageInput extends PageInput {
  status?: VanFilter;
}

const NAMES_TAKEN: Record<string, string> = {
  vans_company_name_uidx: 'A van with that name already exists. Give it a different name or plate.',
  registers_branch_name_uidx: 'That branch already has a till with this name. Give the van a different name.',
  vans_active_vehicle_uidx: 'That vehicle is already behind another van that is in use.',
  stock_locations_company_code_uidx: 'A stock location with a similar code already exists. Give the van a different name.',
};

/** Turns a broken uniqueness rule into the sentence for it, and lets any other error through. */
const refuse = (error: unknown): never => {
  const known = NAMES_TAKEN[constraintOf(error) ?? ''];
  if (known !== undefined) throw new VanSalesError(known);
  throw error;
};

/**
 * Vans (docs/architecture/van-sales.md §4.1). A van is its stock location and its till made together, in one transaction, so the three can
 * never drift apart: its stock is a location of its own that no shop, quote or warehouse channel sells from, its cash is a till of its own, and
 * stopping the van stops both. A van with stock on it or a shift open is not stopped. Every change is under a version and in the decision log.
 */
export class VanService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
  ) {}

  private select() {
    return this.db
      .select({
        v: vans,
        branchName: branches.name,
        locationCode: stockLocations.code,
        vehicleName: deliveryVehicles.name,
        cashAccountId: registers.cashAccountId,
        cashAccountName: bankAccounts.name,
        productsOnVan: sql<number>`(SELECT count(*)::int FROM ${stockBalances} b WHERE b.location_id = ${vans.locationId} AND (b.on_hand <> 0 OR b.reserved <> 0))`,
        shiftOpen: sql<boolean>`EXISTS (SELECT 1 FROM ${shifts} s WHERE s.register_id = ${vans.registerId} AND s.status IN ('open','closing'))`,
      })
      .from(vans)
      .innerJoin(branches, eq(branches.id, vans.branchId))
      .innerJoin(stockLocations, eq(stockLocations.id, vans.locationId))
      .innerJoin(registers, eq(registers.id, vans.registerId))
      .leftJoin(deliveryVehicles, eq(deliveryVehicles.id, vans.vehicleId))
      .leftJoin(bankAccounts, eq(bankAccounts.id, registers.cashAccountId));
  }

  private view(r: Awaited<ReturnType<VanService['select']>>[number]): VanView {
    const v = r.v;
    return {
      id: v.id,
      name: v.name,
      branchId: v.branchId,
      branchName: r.branchName,
      locationId: v.locationId,
      locationCode: r.locationCode,
      registerId: v.registerId,
      vehicleId: v.vehicleId,
      vehicleName: r.vehicleName,
      cashAccountId: r.cashAccountId,
      cashAccountName: r.cashAccountName,
      maxCash: v.maxCash === null ? null : Number(v.maxCash),
      status: v.status === 'stopped' ? 'stopped' : 'active',
      statusReason: v.statusReason,
      version: v.version,
      productsOnVan: r.productsOnVan,
      shiftOpen: r.shiftOpen,
    };
  }

  /** One page of the company's vans, by name. */
  async page(companyId: string, input: VanPageInput): Promise<{ rows: VanView[]; nextCursor: string | null }> {
    const status = input.status ?? 'active';
    const rows = await this.select()
      .where(and(eq(vans.companyId, companyId), status === 'all' ? undefined : eq(vans.status, status), matching(searchText(input), [vans.name, stockLocations.code]), afterCursor(input.cursor, vans.name, vans.id)))
      .orderBy(asc(vans.name), asc(vans.id))
      .limit(PAGE_SIZE + 1);
    const page = pageOf(rows, PAGE_SIZE, (r) => ({ k: r.v.name, id: r.v.id }));
    return { rows: page.rows.map((r) => this.view(r)), nextCursor: page.nextCursor };
  }

  async get(companyId: string, id: string): Promise<VanView> {
    if (!isId(id)) throw new VanSalesError('That van could not be found.');
    const [row] = await this.select().where(and(eq(vans.companyId, companyId), eq(vans.id, id))).limit(1);
    if (row === undefined) throw new VanSalesError('That van could not be found.');
    return this.view(row);
  }

  async counts(companyId: string): Promise<{ active: number; stopped: number }> {
    const rows = await this.db.select({ status: vans.status, n: sql<number>`count(*)::int` }).from(vans).where(eq(vans.companyId, companyId)).groupBy(vans.status);
    return { active: rows.find((r) => r.status === 'active')?.n ?? 0, stopped: rows.find((r) => r.status === 'stopped')?.n ?? 0 };
  }

  /** The branch, vehicle and cash account must be the company's own (and usable); the vehicle must not be behind another van in use. */
  private async checkParts(tx: Tx, companyId: string, v: Pick<VanInput, 'branchId' | 'vehicleId' | 'cashAccountId'>, vanId: string | null): Promise<void> {
    const [branch] = await tx.select({ id: branches.id }).from(branches).where(and(eq(branches.id, v.branchId), eq(branches.companyId, companyId), eq(branches.isActive, true))).limit(1);
    if (branch === undefined) throw new VanSalesError('Choose one of the company\'s branches that is in use.');
    if (v.vehicleId !== null) {
      const [vehicle] = await tx.select({ id: deliveryVehicles.id }).from(deliveryVehicles).where(and(eq(deliveryVehicles.id, v.vehicleId), eq(deliveryVehicles.companyId, companyId), eq(deliveryVehicles.isActive, true))).limit(1);
      if (vehicle === undefined) throw new VanSalesError('Choose one of the company\'s vehicles that is in use.');
      const [other] = await tx.select({ name: vans.name }).from(vans).where(and(eq(vans.vehicleId, v.vehicleId), eq(vans.status, 'active'), vanId === null ? undefined : sql`${vans.id} <> ${vanId}`)).limit(1);
      if (other !== undefined) throw new VanSalesError(`That vehicle is already behind the van ${other.name}.`);
    }
    if (v.cashAccountId !== null) {
      const [cash] = await tx.select({ id: bankAccounts.id }).from(bankAccounts).where(and(eq(bankAccounts.id, v.cashAccountId), eq(bankAccounts.companyId, companyId), eq(bankAccounts.kind, 'cash'), eq(bankAccounts.blocked, false))).limit(1);
      if (cash === undefined) throw new VanSalesError('Choose one of the company\'s cash accounts.');
    }
  }

  async create(companyId: string, actor: Actor, raw: unknown): Promise<VanView> {
    const read = readVan(raw);
    if (!read.ok) throw new VanSalesError(read.error);
    const v = read.van;
    const id = await this.db
      .transaction(async (tx) => {
        await this.checkParts(tx, companyId, v, null);
        const used = await tx.select({ code: stockLocations.code }).from(stockLocations).where(and(eq(stockLocations.companyId, companyId), ilike(stockLocations.code, 'VAN-%')));
        const code = locationCodeFor(v.name, new Set(used.map((r) => r.code.toLowerCase())));
        const [location] = await tx
          .insert(stockLocations)
          .values({ companyId, branchId: v.branchId, code, name: v.name, kind: 'van', isSellable: true, sellsChannels: [VAN_CHANNEL], fulfilsDelivery: false, allowNegative: false })
          .returning({ id: stockLocations.id });
        const [till] = await tx.insert(registers).values({ companyId, branchId: v.branchId, name: v.name, cashAccountId: v.cashAccountId, isActive: true, createdBy: actor.id ?? 'system' }).returning({ id: registers.id });
        if (location === undefined || till === undefined) throw new VanSalesError('The van could not be saved. Please try again.');
        const [van] = await tx
          .insert(vans)
          .values({ companyId, branchId: v.branchId, name: v.name, locationId: location.id, registerId: till.id, vehicleId: v.vehicleId, maxCash: v.maxCash === null ? null : v.maxCash.toFixed(2), createdBy: actor.id ?? 'system' })
          .returning({ id: vans.id });
        if (van === undefined) throw new VanSalesError('The van could not be saved. Please try again.');
        await this.decisions.record({ companyId, actor, subject: { type: 'van', id: van.id }, action: 'van.created', reason: { text: v.name }, inputs: {}, outcome: { ...v, locationCode: code } }, tx);
        return van.id;
      })
      .catch(refuse);
    return await this.get(companyId, id);
  }

  private async locked(tx: Tx, companyId: string, id: string, expectedVersion: unknown) {
    if (!isId(id)) throw new VanSalesError('That van could not be found.');
    const [row] = await tx.select().from(vans).where(and(eq(vans.companyId, companyId), eq(vans.id, id))).limit(1).for('update');
    if (row === undefined) throw new VanSalesError('That van could not be found.');
    if (expectedVersion !== row.version) throw new VanSalesError('Someone else changed this van while you were looking at it. Reload the page to see the latest.');
    return row;
  }

  /** Changes a van's name, vehicle, till account and cash limit. Its branch stays: to move a van to another branch, add a new van. */
  async update(companyId: string, actor: Actor, id: string, raw: unknown, expectedVersion: unknown): Promise<VanView> {
    const read = readVan(raw);
    if (!read.ok) throw new VanSalesError(read.error);
    const v = read.van;
    await this.db
      .transaction(async (tx) => {
        const row = await this.locked(tx, companyId, id, expectedVersion);
        if (v.branchId !== row.branchId) throw new VanSalesError('A van stays in its branch. To move it to another branch, add a new van there and stop this one.');
        if (row.status !== 'active') throw new VanSalesError('This van is stopped. Use it again before changing it.');
        await this.checkParts(tx, companyId, v, row.id);
        if (v.cashAccountId !== null) {
          const [open] = await tx.select({ id: shifts.id }).from(shifts).where(and(eq(shifts.registerId, row.registerId), sql`${shifts.status} IN ('open','closing')`)).limit(1);
          const [till] = await tx.select({ cash: registers.cashAccountId }).from(registers).where(eq(registers.id, row.registerId)).limit(1);
          if (open !== undefined && till?.cash !== v.cashAccountId) throw new VanSalesError('The van\'s till has a shift open. Close it before changing the cash account.');
        }
        await tx.update(vans).set({ name: v.name, vehicleId: v.vehicleId, maxCash: v.maxCash === null ? null : v.maxCash.toFixed(2), version: row.version + 1, updatedAt: new Date() }).where(eq(vans.id, row.id));
        await tx.update(stockLocations).set({ name: v.name, updatedAt: new Date() }).where(eq(stockLocations.id, row.locationId));
        await tx.update(registers).set({ name: v.name, cashAccountId: v.cashAccountId, updatedAt: new Date() }).where(eq(registers.id, row.registerId));
        await this.decisions.record({ companyId, actor, subject: { type: 'van', id: row.id }, action: 'van.changed', reason: { text: v.name }, inputs: { name: row.name, vehicleId: row.vehicleId, maxCash: row.maxCash }, outcome: { name: v.name, vehicleId: v.vehicleId, maxCash: v.maxCash } }, tx);
      })
      .catch(refuse);
    return await this.get(companyId, id);
  }

  /** Stops a van (with a reason) or puts it back in use. A van with stock on it, or a shift open on its till, is not stopped. */
  async setActive(companyId: string, actor: Actor, id: string, input: { active: boolean; reason?: unknown; expectedVersion: unknown }): Promise<VanView> {
    const why = input.active ? null : readReason(input.reason);
    if (why !== null && !why.ok) throw new VanSalesError(why.error);
    await this.db
      .transaction(async (tx) => {
        const row = await this.locked(tx, companyId, id, input.expectedVersion);
        if (input.active === (row.status === 'active')) throw new VanSalesError(input.active ? 'This van is already in use.' : 'This van is already stopped.');
        if (!input.active) {
          const [held] = await tx.select({ n: sql<number>`count(*)::int` }).from(stockBalances).where(and(eq(stockBalances.locationId, row.locationId), sql`(${stockBalances.onHand} <> 0 OR ${stockBalances.reserved} <> 0)`));
          if ((held?.n ?? 0) > 0) throw new VanSalesError(`This van still holds or has promised stock of ${String(held?.n ?? 0)} product${held?.n === 1 ? '' : 's'}. Unload it to the warehouse first.`);
          const [open] = await tx.select({ id: shifts.id }).from(shifts).where(and(eq(shifts.registerId, row.registerId), sql`${shifts.status} IN ('open','closing')`)).limit(1);
          if (open !== undefined) throw new VanSalesError('The van\'s till has a shift open. Close it before stopping the van.');
          const [route] = await tx.select({ name: salesRoutes.name }).from(salesRoutes).where(and(eq(salesRoutes.defaultVanId, row.id), eq(salesRoutes.status, 'active'))).limit(1);
          if (route !== undefined) throw new VanSalesError(`This van is the usual van of the route ${route.name}. Choose another van for that route first.`);
        } else {
          await this.checkParts(tx, companyId, { branchId: row.branchId, vehicleId: row.vehicleId, cashAccountId: null }, row.id);
        }
        const status = input.active ? 'active' : 'stopped';
        await tx.update(vans).set({ status, statusReason: why?.reason ?? null, version: row.version + 1, updatedAt: new Date() }).where(eq(vans.id, row.id));
        await tx.update(stockLocations).set({ isActive: input.active, updatedAt: new Date() }).where(eq(stockLocations.id, row.locationId));
        await tx.update(registers).set({ isActive: input.active, updatedAt: new Date() }).where(eq(registers.id, row.registerId));
        await this.decisions.record({ companyId, actor, subject: { type: 'van', id: row.id }, action: input.active ? 'van.resumed' : 'van.stopped', reason: { text: why?.reason ?? row.name }, inputs: { status: row.status }, outcome: { status } }, tx);
      })
      .catch(refuse);
    return await this.get(companyId, id);
  }
}
