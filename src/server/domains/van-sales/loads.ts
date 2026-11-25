import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { products, routeParLevels, salesReps, stockBalances, stockLocations, stockSettings, unitsOfMeasure, users, vanDays, vanLoads, vans } from '@/server/db/drizzle/schema';
import type { Actor } from '@/server/kernel/context';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { LOAD_KINDS, LOAD_STATE_WORDS, loadSteps, readSign, suggestLoad, type LoadKind, type LoadSteps } from '@/lib/van-sales/load';
import { isId, readReason } from '@/lib/van-sales/people';
import { readPar } from '@/lib/van-sales/routes';
import { readDayStatus } from '@/lib/van-sales/days';
import { roundQty } from '@/lib/decimal';
import { StockError } from '@/server/domains/stock/errors';
import type { TransferService } from '@/server/domains/stock/transfers';
import { recordDayEvent } from './day-events';
import { constraintOf, VanSalesError } from './errors';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

export interface LoadLineView {
  productId: string;
  productName: string;
  asked: number;
  shipped: number;
  received: number;
  /** Sent and not yet signed for or settled. */
  inTransit: number;
}

export interface LoadView {
  id: string;
  dayId: string;
  kind: LoadKind;
  transferId: string;
  number: string;
  state: string;
  stateWords: string;
  fromName: string;
  createdAt: string;
  signedAt: string | null;
  signedByName: string | null;
  signedOnBehalf: boolean;
  signReason: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  lines: LoadLineView[];
  steps: LoadSteps;
}

export interface SuggestRow {
  productId: string;
  productName: string;
  sku: string;
  unitName: string;
  decimals: number;
  par: number;
  onVan: number;
  drops: number;
  wanted: number;
  /** What the warehouse has that is not promised to a customer. */
  available: number;
  loadable: number;
  short: number;
}

export interface Suggestion {
  /** The place the load would come from, and the other places it could. */
  source: { id: string; name: string; code: string } | null;
  rows: SuggestRow[];
  /** Why there is nothing to suggest, in words. */
  note: string | null;
}

export interface OnVanRow {
  productId: string;
  productName: string;
  sku: string;
  unitName: string;
  onHand: number;
  reserved: number;
}

const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
const LOADABLE_FROM = ['warehouse', 'store'];

/** A stock rule from the transfer service, told to the person in its own words. */
const told = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    if (error instanceof StockError) throw new VanSalesError(error.message);
    throw error;
  }
};

/**
 * Loading a van (docs/architecture/van-sales.md §6.2, §6.3). A load is a stock transfer from a warehouse to the van's own stock place, made up
 * from the route's usual stock less what is already on the van (and, once orders are taken, the orders to hand over), limited by what the
 * warehouse has that is not promised to a customer. It is asked for, approved where the company wants a second person to, sent (the stock
 * leaves the warehouse into transit) and signed for by the rep (the stock arrives on the van). Signing by the office for the rep needs a reason
 * and is shown as such. Each step is in the day's history.
 */
export class VanLoadService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly transfers: TransferService,
  ) {}

  // ── The planner ──────────────────────────────────────────────────────

  private async dayFacts(db: Pick<DrizzleDb, 'select'>, companyId: string, dayId: string) {
    if (!isId(dayId)) throw new VanSalesError('That day could not be found.');
    const [row] = await db
      .select({ d: vanDays, vanLocationId: vans.locationId, vanName: vans.name, repUserId: salesReps.userId, repName: salesReps.name })
      .from(vanDays)
      .innerJoin(salesReps, eq(salesReps.id, vanDays.repId))
      .leftJoin(vans, eq(vans.id, vanDays.vanId))
      .where(and(eq(vanDays.companyId, companyId), eq(vanDays.id, dayId)))
      .limit(1);
    if (row === undefined) throw new VanSalesError('That day could not be found.');
    return row;
  }

  /** The places a load can come from, the day's branch first, then the company's default. */
  private async sources(db: Pick<DrizzleDb, 'select'>, companyId: string, branchId: string) {
    return await db
      .select({ id: stockLocations.id, name: stockLocations.name, code: stockLocations.code })
      .from(stockLocations)
      .where(and(eq(stockLocations.companyId, companyId), eq(stockLocations.isActive, true), inArray(stockLocations.kind, LOADABLE_FROM)))
      .orderBy(sql`COALESCE(${stockLocations.branchId} = ${branchId}::uuid, false) DESC`, desc(stockLocations.isDefault), asc(stockLocations.code))
      .limit(1);
  }

  /** What to load for a day: the route's usual stock less what is on the van, as far as the warehouse can give it. */
  async suggest(companyId: string, dayId: string, fromLocationId?: unknown): Promise<Suggestion> {
    const day = await this.dayFacts(this.db, companyId, dayId);
    if (day.d.vanId === null || day.vanLocationId === null) return { source: null, rows: [], note: 'A day that only takes orders has no van to load.' };
    let source: { id: string; name: string; code: string } | undefined;
    if (isId(fromLocationId)) {
      [source] = await this.db.select({ id: stockLocations.id, name: stockLocations.name, code: stockLocations.code }).from(stockLocations).where(and(eq(stockLocations.id, fromLocationId), eq(stockLocations.companyId, companyId), eq(stockLocations.isActive, true), inArray(stockLocations.kind, LOADABLE_FROM))).limit(1);
      if (source === undefined) throw new VanSalesError('Choose a warehouse or store that is in use to load from.');
    } else {
      [source] = await this.sources(this.db, companyId, day.d.branchId);
    }
    if (source === undefined) return { source: null, rows: [], note: 'There is no warehouse or store to load from. Add one under Stock › Locations.' };
    const par = await this.db
      .select({ productId: routeParLevels.productId, quantity: routeParLevels.quantity, name: products.name, sku: products.sku, unitName: unitsOfMeasure.name, decimals: unitsOfMeasure.decimals })
      .from(routeParLevels)
      .innerJoin(products, eq(products.id, routeParLevels.productId))
      .leftJoin(unitsOfMeasure, eq(unitsOfMeasure.id, products.baseUnitId))
      .where(eq(routeParLevels.routeId, day.d.routeId));
    if (par.length === 0) return { source, rows: [], note: 'This route has no usual stock set, so there is nothing to suggest. Set it on the route, or choose the products by hand.' };
    const ids = par.map((p) => p.productId);
    const [onVan, free] = await Promise.all([
      this.db.select({ productId: stockBalances.productId, n: sql<number>`COALESCE(sum(${stockBalances.onHand}), 0)::float8` }).from(stockBalances).where(and(eq(stockBalances.locationId, day.vanLocationId), inArray(stockBalances.productId, ids))).groupBy(stockBalances.productId),
      this.db.select({ productId: stockBalances.productId, n: sql<number>`COALESCE(sum(${stockBalances.onHand} - ${stockBalances.reserved}), 0)::float8` }).from(stockBalances).where(and(eq(stockBalances.locationId, source.id), inArray(stockBalances.productId, ids))).groupBy(stockBalances.productId),
    ]);
    const onVanBy = new Map(onVan.map((r) => [r.productId, r.n]));
    const freeBy = new Map(free.map((r) => [r.productId, Math.max(r.n, 0)]));
    const plan = suggestLoad({ par: new Map(par.map((p) => [p.productId, p.quantity])), onVan: onVanBy, drops: new Map(), warehouse: freeBy });
    const byProduct = new Map(par.map((p) => [p.productId, p]));
    const rows: SuggestRow[] = plan.flatMap((r) => {
      const p = byProduct.get(r.productId);
      return p === undefined ? [] : [{ productId: r.productId, productName: p.name, sku: p.sku, unitName: p.unitName ?? 'unit', decimals: p.decimals ?? 3, par: r.par, onVan: r.onVan, drops: r.drops, wanted: r.wanted, available: roundQty(freeBy.get(r.productId) ?? 0), loadable: r.loadable, short: r.short }];
    });
    rows.sort((a, b) => a.productName.localeCompare(b.productName));
    return { source, rows, note: rows.length === 0 ? 'The van already has its usual stock.' : null };
  }

  /** What is on the van now. */
  async onVan(companyId: string, dayId: string): Promise<OnVanRow[]> {
    const day = await this.dayFacts(this.db, companyId, dayId);
    if (day.vanLocationId === null) return [];
    const rows = await this.db
      .select({ productId: stockBalances.productId, onHand: sql<number>`sum(${stockBalances.onHand})::float8`, reserved: sql<number>`sum(${stockBalances.reserved})::float8`, name: products.name, sku: products.sku, unitName: unitsOfMeasure.name })
      .from(stockBalances)
      .innerJoin(products, eq(products.id, stockBalances.productId))
      .leftJoin(unitsOfMeasure, eq(unitsOfMeasure.id, products.baseUnitId))
      .where(eq(stockBalances.locationId, day.vanLocationId))
      .groupBy(stockBalances.productId, products.name, products.sku, unitsOfMeasure.name)
      .having(sql`sum(${stockBalances.onHand}) <> 0 OR sum(${stockBalances.reserved}) <> 0`)
      .orderBy(asc(products.name))
      .limit(500);
    return rows.map((r) => ({ productId: r.productId, productName: r.name, sku: r.sku, unitName: r.unitName ?? 'unit', onHand: roundQty(r.onHand), reserved: roundQty(r.reserved) }));
  }

  // ── The loads of a day ───────────────────────────────────────────────

  async list(companyId: string, dayId: string): Promise<LoadView[]> {
    await this.dayFacts(this.db, companyId, dayId);
    const rows = await this.db
      .select({ l: vanLoads, from: stockLocations.name, signer: users.name })
      .from(vanLoads)
      .innerJoin(stockLocations, eq(stockLocations.id, vanLoads.fromLocationId))
      .leftJoin(users, sql`${users.id}::text = ${vanLoads.signedBy}`)
      .where(and(eq(vanLoads.companyId, companyId), eq(vanLoads.dayId, dayId)))
      .orderBy(asc(vanLoads.createdAt), asc(vanLoads.id));
    const [settings] = await this.db.select({ approval: stockSettings.transferRequiresApproval }).from(stockSettings).where(eq(stockSettings.companyId, companyId)).limit(1);
    const needsApproval = settings?.approval === true;
    const views: LoadView[] = [];
    for (const r of rows) {
      const transfer = await told(() => this.transfers.get(companyId, r.l.transferId));
      const state = transfer.document.state;
      views.push({
        id: r.l.id,
        dayId: r.l.dayId,
        kind: r.l.kind === 'top_up' ? 'top_up' : 'load',
        transferId: r.l.transferId,
        number: transfer.document.number,
        state,
        stateWords: r.l.cancelledAt === null ? (LOAD_STATE_WORDS[state] ?? state) : LOAD_STATE_WORDS.cancelled ?? 'Cancelled',
        fromName: r.from,
        createdAt: r.l.createdAt.toISOString(),
        signedAt: r.l.signedAt?.toISOString() ?? null,
        signedByName: r.signer,
        signedOnBehalf: r.l.signedOnBehalf,
        signReason: r.l.signReason,
        cancelledAt: r.l.cancelledAt?.toISOString() ?? null,
        cancelReason: r.l.cancelReason,
        lines: transfer.lines.map((x) => ({ productId: x.productId, productName: x.productName, asked: x.quantity, shipped: x.shippedQuantity, received: x.receivedQuantity, inTransit: x.inTransit })),
        steps: loadSteps({ state, signed: r.l.signedAt !== null, cancelled: r.l.cancelledAt !== null, needsApproval }),
      });
    }
    return views;
  }

  private async loadFacts(db: Pick<DrizzleDb, 'select'>, companyId: string, loadId: string) {
    if (!isId(loadId)) throw new VanSalesError('That load could not be found.');
    const [row] = await db.select().from(vanLoads).where(and(eq(vanLoads.id, loadId), eq(vanLoads.companyId, companyId))).limit(1);
    if (row === undefined) throw new VanSalesError('That load could not be found.');
    return row;
  }

  /** Makes up a load (or a top-up while the day is out) as a transfer from a warehouse to the van, asked for. */
  async create(companyId: string, actor: Actor, dayId: string, raw: unknown): Promise<LoadView[]> {
    const i = obj(raw);
    const kind = LOAD_KINDS.find((k) => k === i.kind);
    if (kind === undefined) throw new VanSalesError('Say whether this is the day\'s load or a top-up.');
    const read = readPar(i.lines);
    if (!read.ok) throw new VanSalesError(read.error);
    const lines = read.rows.filter((l) => l.quantity > 0);
    if (lines.length === 0) throw new VanSalesError('Add at least one product to load.');
    const day = await this.dayFacts(this.db, companyId, dayId);
    const status = readDayStatus(day.d.status) ?? 'planned';
    if (day.d.vanId === null || day.vanLocationId === null) throw new VanSalesError('A day that only takes orders has no van to load.');
    if (kind === 'load' && status !== 'planned' && status !== 'loading') throw new VanSalesError('The day\'s load is made up before the day goes out. Make a top-up instead.');
    if (kind === 'top_up' && status !== 'out') throw new VanSalesError('A top-up is for a day that is out on the route.');
    const fromId = isId(i.fromLocationId) ? i.fromLocationId : (await this.sources(this.db, companyId, day.d.branchId))[0]?.id;
    if (fromId === undefined) throw new VanSalesError('There is no warehouse or store to load from. Add one under Stock › Locations.');
    const [from] = await this.db.select({ id: stockLocations.id, kind: stockLocations.kind, isActive: stockLocations.isActive }).from(stockLocations).where(and(eq(stockLocations.id, fromId), eq(stockLocations.companyId, companyId))).limit(1);
    if (from?.isActive !== true || !LOADABLE_FROM.includes(from.kind)) throw new VanSalesError('Choose a warehouse or store that is in use to load from.');

    if (kind === 'load') {
      const [existing] = await this.db.select({ id: vanLoads.id }).from(vanLoads).where(and(eq(vanLoads.dayId, day.d.id), eq(vanLoads.kind, 'load'), isNull(vanLoads.cancelledAt))).limit(1);
      if (existing !== undefined) throw new VanSalesError('This day already has a load. Call it off, or make a top-up once the day is out.');
    }

    const doc = { id: actor.id ?? 'system' };
    const made = await told(async () => {
      const m = await this.transfers.create(companyId, doc, { fromLocationId: from.id, toLocationId: day.vanLocationId ?? '', note: `${kind === 'load' ? 'Load' : 'Top-up'} for ${day.d.number}`, lines });
      await this.transfers.request(companyId, doc, m.id);
      return m;
    });
    try {
      await this.db.transaction(async (tx) => {
        const [locked] = await tx.select().from(vanDays).where(eq(vanDays.id, day.d.id)).limit(1).for('update');
        const now = readDayStatus(locked?.status ?? '') ?? 'planned';
        if (locked === undefined || (kind === 'load' ? now !== 'planned' && now !== 'loading' : now !== 'out')) throw new VanSalesError('The day changed while the load was being made up. Reload the page and try again.');
        await tx.insert(vanLoads).values({ companyId, dayId: day.d.id, kind, transferId: made.id, fromLocationId: from.id, createdBy: actor.id ?? 'system' });
        if (kind === 'load' && now === 'planned') {
          await tx.update(vanDays).set({ status: 'loading', version: locked.version + 1, updatedAt: new Date() }).where(eq(vanDays.id, day.d.id));
          await recordDayEvent(tx, this.decisions, companyId, day.d.id, actor, 'day.loading', { from: 'planned', to: 'loading' });
        } else {
          await tx.update(vanDays).set({ version: locked.version + 1, updatedAt: new Date() }).where(eq(vanDays.id, day.d.id));
        }
        await recordDayEvent(tx, this.decisions, companyId, day.d.id, actor, 'day.load_created', { detail: { kind, transfer: made.number, lines: lines.length } });
      });
    } catch (error) {
      // The load could not be tied to its day: the transfer made for it is called off so nothing is left hanging.
      await this.transfers.cancel(companyId, doc, made.id, 'The load could not be attached to its day').catch(() => undefined);
      if (constraintOf(error) === 'van_loads_day_load_uidx') throw new VanSalesError('This day already has a load. Call it off, or make a top-up once the day is out.');
      throw error;
    }
    return await this.list(companyId, dayId);
  }

  /** A second person agrees (only where the company wants transfers approved). */
  async approve(companyId: string, actor: Actor, loadId: string): Promise<LoadView[]> {
    const load = await this.loadFacts(this.db, companyId, loadId);
    if (load.cancelledAt !== null) throw new VanSalesError('That load was called off.');
    await told(async () => await this.transfers.approve(companyId, { id: actor.id ?? 'system' }, load.transferId));
    await this.db.transaction(async (tx) => await recordDayEvent(tx, this.decisions, companyId, load.dayId, actor, 'day.load_approved', { detail: { transferId: load.transferId } }));
    return await this.list(companyId, load.dayId);
  }

  /** The stock leaves the warehouse for the van: it is on its way until the rep signs for it. */
  async ship(companyId: string, actor: Actor, loadId: string): Promise<LoadView[]> {
    const load = await this.loadFacts(this.db, companyId, loadId);
    if (load.cancelledAt !== null) throw new VanSalesError('That load was called off.');
    await told(async () => await this.transfers.ship(companyId, { id: actor.id ?? 'system' }, load.transferId));
    await this.db.transaction(async (tx) => await recordDayEvent(tx, this.decisions, companyId, load.dayId, actor, 'day.load_shipped', { detail: { transferId: load.transferId } }));
    return await this.list(companyId, load.dayId);
  }

  /**
   * The rep signs for what arrived on the van: everything that was sent, or the quantities counted. The office may sign for a rep who is on
   * the road or signed on paper, but only with a reason, and the load shows that it was signed on their behalf. What did not arrive stays in
   * transit to be settled under Stock › Transfers.
   */
  async sign(companyId: string, actor: Actor, loadId: string, raw: unknown, who: { maySell: boolean; mayPlan: boolean }): Promise<LoadView[]> {
    const read = readSign(raw);
    if (!read.ok) throw new VanSalesError(read.error);
    const load = await this.loadFacts(this.db, companyId, loadId);
    const day = await this.dayFacts(this.db, companyId, load.dayId);
    const isRep = actor.id === day.repUserId;
    if (!isRep && !who.mayPlan) throw new VanSalesError(`Only ${day.repName} signs for their own load. The office may sign for them, with a reason.`);
    if (isRep && !who.maySell) throw new VanSalesError('You are not allowed to sign for a load.');
    const why = isRep ? null : readReason(read.sign.reason);
    if (why !== null && !why.ok) throw new VanSalesError(`Signing for ${day.repName} needs a reason: ${why.error.toLowerCase()}`);
    if (load.cancelledAt !== null) throw new VanSalesError('That load was called off.');
    if (load.signedAt !== null) throw new VanSalesError('This load is already signed for.');

    const transfer = await told(() => this.transfers.get(companyId, load.transferId));
    if (transfer.document.state !== 'shipped' && transfer.document.state !== 'partly_received') throw new VanSalesError('This load has not left the warehouse yet, so there is nothing to sign for.');
    const left = transfer.lines.map((l) => ({ line: l, left: l.inTransit }));
    const asked = read.sign.entries;
    if (asked !== null) for (const e of asked) if (!left.some((l) => l.line.productId === e.productId)) throw new VanSalesError('A product you counted is not on this load.');
    const entries = left.flatMap((l) => {
      const q = asked === null ? l.left : (asked.find((e) => e.productId === l.line.productId)?.quantity ?? 0);
      if (q > l.left) throw new VanSalesError(`Only ${String(l.left)} of "${l.line.productName}" was sent, and ${String(q)} was counted.`);
      return q > 0 ? [{ lineId: l.line.id, quantity: q }] : [];
    });
    if (entries.length === 0) throw new VanSalesError('Count at least one product onto the van.');
    await told(async () => await this.transfers.receive(companyId, { id: actor.id ?? 'system' }, load.transferId, entries));

    const total = roundQty(entries.reduce((n, e) => n + e.quantity, 0));
    await this.db.transaction(async (tx) => {
      const marked = await tx
        .update(vanLoads)
        .set({ signedBy: actor.id ?? 'system', signedAt: new Date(), signedOnBehalf: !isRep, signReason: why?.reason ?? null })
        .where(and(eq(vanLoads.id, load.id), isNull(vanLoads.signedAt)))
        .returning({ id: vanLoads.id });
      if (marked.length === 0) return;
      await recordDayEvent(tx, this.decisions, companyId, load.dayId, actor, 'day.load_signed', { reason: why?.reason, detail: { transferId: load.transferId, quantity: total, onBehalf: !isRep } });
    });
    return await this.list(companyId, load.dayId);
  }

  /** Calls off a load that has not left the warehouse. */
  async cancel(companyId: string, actor: Actor, loadId: string, reason: unknown): Promise<LoadView[]> {
    const why = readReason(reason);
    if (!why.ok) throw new VanSalesError(why.error);
    const load = await this.loadFacts(this.db, companyId, loadId);
    if (load.cancelledAt !== null) throw new VanSalesError('That load is already called off.');
    await told(async () => await this.transfers.cancel(companyId, { id: actor.id ?? 'system' }, load.transferId, why.reason));
    await this.db.transaction(async (tx: Tx) => {
      await tx.update(vanLoads).set({ cancelledAt: new Date(), cancelReason: why.reason }).where(and(eq(vanLoads.id, load.id), isNull(vanLoads.cancelledAt)));
      await recordDayEvent(tx, this.decisions, companyId, load.dayId, actor, 'day.load_cancelled', { reason: why.reason, detail: { transferId: load.transferId } });
    });
    return await this.list(companyId, load.dayId);
  }

  /** Whether the stock settings ask for a second person to approve a transfer. */
  async needsApproval(companyId: string): Promise<boolean> {
    const [settings] = await this.db.select({ approval: stockSettings.transferRequiresApproval }).from(stockSettings).where(eq(stockSettings.companyId, companyId)).limit(1);
    return settings?.approval === true;
  }
}

