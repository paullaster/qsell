import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { products, salesReps, users, vanDayShortages, vanDays, vanLoads } from '@/server/db/drizzle/schema';
import type { Actor } from '@/server/kernel/context';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { ShiftService } from '@/server/domains/selling/shifts/shift-service';
import { parseCount } from '@/server/domains/selling/shifts/shift-rules';
import type { TransferService } from '@/server/domains/stock/transfers';
import { StockError } from '@/server/domains/stock/errors';
import { readDayStatus } from '@/lib/van-sales/days';
import { isId } from '@/lib/van-sales/people';
import { closeDayProblem, decideProblem, readDecision, readTillCount, tillProblem, type ShortageRule, type TillStatus } from '@/lib/van-sales/settle';
import { recordDayEvent } from './day-events';
import { VanSalesError } from './errors';
import type { VanLoadService } from './loads';
import type { VanSalesSettingsService } from './settings-service';

export interface ShortageView {
  id: string;
  productName: string;
  quantity: number;
  value: number;
  rule: ShortageRule;
  needsApproval: boolean;
  decided: boolean;
  decision: ShortageRule | null;
  reason: string | null;
  decidedByName: string | null;
  chargedAmount: number | null;
}

export interface SettleView {
  /** The company's rule for a shortage, and the value above which a manager decides it. */
  rule: ShortageRule;
  limit: number;
  shortages: ShortageView[];
  undecided: number;
  till: { status: TillStatus; zNumber: string | null; variance: number | null; waitingForApproval: boolean };
  tillProblem: string | null;
  closeProblem: string | null;
}

const ruleOf = (value: string): ShortageRule => (value === 'write_off' ? 'write_off' : 'charge_rep');
const round = (n: number): number => Math.round(n * 100) / 100;
const tillStatusOf = (value: string | undefined): TillStatus => (value === 'open' || value === 'closing' || value === 'closed' ? value : null);

/**
 * Settling the day (docs/architecture/van-sales.md §5.3, §7): the shortages found at the unload are decided (the stock written off, and by the company's
 * rule the value charged to the rep), the van's till is counted and closed through the till's own close, and the day is closed. Each step says what is in
 * the way. A shortage worth more than the company's limit is decided by a manager, and never by the rep whose van it was.
 */
export class VanSettleService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly transfers: TransferService,
    private readonly shifts: ShiftService,
    private readonly settings: VanSalesSettingsService,
    private readonly loads: VanLoadService,
  ) {}

  private async dayRow(companyId: string, dayId: string) {
    if (!isId(dayId)) throw new VanSalesError('That day could not be found.');
    const [row] = await this.db.select({ d: vanDays, repUser: salesReps.userId, repName: salesReps.name }).from(vanDays).innerJoin(salesReps, eq(salesReps.id, vanDays.repId)).where(and(eq(vanDays.id, dayId), eq(vanDays.companyId, companyId))).limit(1);
    if (row === undefined) throw new VanSalesError('That day could not be found.');
    return row;
  }

  /** The shortages of the day, the till and why the day cannot be closed yet, for the screen. */
  async view(companyId: string, dayId: string): Promise<SettleView> {
    const { d } = await this.dayRow(companyId, dayId);
    const cfg = await this.settings.current(companyId);
    const rows = await this.db
      .select({ s: vanDayShortages, name: products.name, by: users.name })
      .from(vanDayShortages)
      .innerJoin(products, eq(products.id, vanDayShortages.productId))
      .leftJoin(users, sql`${users.id}::text = ${vanDayShortages.decidedBy}`)
      .where(eq(vanDayShortages.dayId, dayId))
      .orderBy(asc(vanDayShortages.createdAt), asc(vanDayShortages.id));
    const shortages = rows.map((r): ShortageView => ({ id: r.s.id, productName: r.name, quantity: Number(r.s.quantity), value: Number(r.s.value), rule: ruleOf(r.s.rule), needsApproval: r.s.needsApproval, decided: r.s.decision !== null, decision: r.s.decision === null ? null : ruleOf(r.s.decision), reason: r.s.reason, decidedByName: r.by, chargedAmount: r.s.chargedAmount === null ? null : Number(r.s.chargedAmount) }));
    const undecided = shortages.filter((s) => !s.decided).length;
    const report = d.shiftId === null ? null : await this.shifts.report(companyId, d.shiftId);
    const status = readDayStatus(d.status) ?? 'planned';
    const shift = tillStatusOf(report?.status);
    const end = await this.loads.endFacts(companyId, dayId);
    return {
      rule: ruleOf(cfg.shortage),
      limit: cfg.shortageApprovalAbove,
      shortages,
      undecided,
      till: { status: shift, zNumber: report?.zNumber ?? null, variance: report?.variance ?? null, waitingForApproval: report?.closeRequest !== null && report !== null },
      tillProblem: tillProblem({ dayStatus: status, shift }),
      closeProblem: closeDayProblem({ dayStatus: status, hasVan: d.vanId !== null, unload: end.unload, productsOnVan: end.onVan, undecided, shift }),
    };
  }

  /** Decides a shortage: the stock that did not arrive is written off with the reason, and, where the company's rule is to charge the rep, its value is charged to them. */
  async decide(companyId: string, actor: Actor, dayId: string, shortageId: string, raw: unknown, perms: { mayReconcile: boolean; mayApprove: boolean }): Promise<void> {
    if (!perms.mayReconcile) throw new VanSalesError('You are not allowed to settle a van day.');
    const read = readDecision(raw);
    if (!read.ok) throw new VanSalesError(read.error);
    const row = await this.dayRow(companyId, dayId);
    if (!isId(shortageId)) throw new VanSalesError('That shortage could not be found.');
    const [short] = await this.db.select({ s: vanDayShortages, name: products.name, transferId: vanLoads.transferId }).from(vanDayShortages).innerJoin(products, eq(products.id, vanDayShortages.productId)).innerJoin(vanLoads, eq(vanLoads.id, vanDayShortages.loadId)).where(and(eq(vanDayShortages.id, shortageId), eq(vanDayShortages.dayId, dayId), eq(vanDayShortages.companyId, companyId))).limit(1);
    if (short === undefined) throw new VanSalesError('That shortage could not be found.');
    const cfg = await this.settings.current(companyId);
    const problem = decideProblem({ dayStatus: row.d.status, decided: short.s.decision !== null, value: Number(short.s.value), limit: cfg.shortageApprovalAbove, mayApprove: perms.mayApprove, isRep: row.repUser === actor.id });
    if (problem !== null) throw new VanSalesError(problem);
    const rule = ruleOf(short.s.rule);
    try {
      await this.transfers.resolve(companyId, { id: actor.id ?? 'system' }, short.transferId, [{ lineId: short.s.lineId, quantity: Number(short.s.quantity), action: 'write_off' }], `Van shortage on ${row.d.number}: ${read.reason}`);
    } catch (error) {
      if (error instanceof StockError) throw new VanSalesError(error.message);
      throw error;
    }
    await this.db.transaction(async (tx) => {
      const done = await tx
        .update(vanDayShortages)
        .set({ decision: rule, reason: read.reason, decidedBy: actor.id ?? 'system', decidedAt: new Date(), chargedRepId: rule === 'charge_rep' ? row.d.repId : null, chargedAmount: rule === 'charge_rep' ? short.s.value : null })
        .where(and(eq(vanDayShortages.id, shortageId), isNull(vanDayShortages.decision)))
        .returning({ id: vanDayShortages.id });
      if (done.length === 0) return;
      await recordDayEvent(tx, this.decisions, companyId, dayId, actor, 'day.shortage_decided', { reason: read.reason, detail: { product: short.name, quantity: Number(short.s.quantity), value: Number(short.s.value), decision: rule, rep: rule === 'charge_rep' ? row.repName : null } });
    });
  }

  /**
   * Counts the van's till and closes its shift through the till's own close: the difference from what it should hold needs a reason, and one beyond the
   * company's allowance a supervisor or the approval queue. The rep may close their own till; anyone else needs to be a supervisor.
   */
  async closeTill(companyId: string, actor: Actor, dayId: string, raw: unknown, perms: { mayClose: boolean; supervisor: boolean }): Promise<{ zNumber: string | null; variance: number; pending: boolean }> {
    if (!perms.mayClose && !perms.supervisor) throw new VanSalesError('You are not allowed to close a till.');
    const row = await this.dayRow(companyId, dayId);
    const status = readDayStatus(row.d.status) ?? 'planned';
    const report = row.d.shiftId === null ? null : await this.shifts.report(companyId, row.d.shiftId);
    const problem = tillProblem({ dayStatus: status, shift: tillStatusOf(report?.status) });
    if (problem !== null) throw new VanSalesError(problem);
    const read = readTillCount(raw);
    if (!read.ok) throw new VanSalesError(read.error);
    const declared = parseCount({ total: read.counted }, 'cash');
    if (!declared.ok) throw new VanSalesError(declared.error);
    const closed = await this.shifts.close(companyId, { userId: actor.id ?? '', supervisor: perms.supervisor }, row.d.shiftId ?? '', { declared, reason: read.reason });
    if (!closed.ok) throw new VanSalesError(closed.error);
    await this.db.transaction(async (tx) => await recordDayEvent(tx, this.decisions, companyId, dayId, actor, 'day.till_closed', { detail: { counted: read.counted, variance: closed.variance, pending: closed.pending, ...(closed.pending ? {} : { z: closed.zNumber }) } }));
    return { zNumber: closed.pending ? null : closed.zNumber, variance: closed.variance, pending: closed.pending };
  }

  /** Closes the day: its stock is back, every shortage decided and its till closed. The rep, the van and the route are free again. */
  async closeDay(companyId: string, actor: Actor, dayId: string, mayReconcile: boolean): Promise<void> {
    if (!mayReconcile) throw new VanSalesError('You are not allowed to settle a van day.');
    const view = await this.view(companyId, dayId);
    if (view.closeProblem !== null) throw new VanSalesError(view.closeProblem);
    await this.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(vanDays).where(and(eq(vanDays.id, dayId), eq(vanDays.companyId, companyId))).limit(1).for('update');
      if (readDayStatus(locked?.status ?? '') !== 'reconciling') throw new VanSalesError('The day changed. Reload the page and try again.');
      await tx.update(vanDays).set({ status: 'closed', version: locked.version + 1, updatedAt: new Date() }).where(eq(vanDays.id, dayId));
      await recordDayEvent(tx, this.decisions, companyId, dayId, actor, 'day.closed', { from: 'reconciling', to: 'closed', detail: { charged: round(view.shortages.reduce((n, s) => n + (s.chargedAmount ?? 0), 0)) } });
    });
  }
}
