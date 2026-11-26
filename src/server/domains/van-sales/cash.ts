import { and, asc, eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { vanCashDrops, vanDays, vans } from '@/server/db/drizzle/schema';
import type { Actor } from '@/server/kernel/context';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { ShiftService } from '@/server/domains/selling/shifts/shift-service';
import { DROP_DESTINATION_WORDS, cashDropProblem, cashState, cashWords, readCashDrop, type CashState, type DropDestination } from '@/lib/van-sales/cash';
import { isId } from '@/lib/van-sales/people';
import { recordDayEvent } from './day-events';
import { VanSalesError } from './errors';
import { ownDay } from './own-day';

export interface CashDropView {
  id: string;
  amount: number;
  destination: DropDestination;
  destinationWords: string;
  note: string | null;
  at: string;
  witnessed: boolean;
}

export interface CashView {
  /** The cash the van's till should hold now. */
  cash: number;
  limit: number | null;
  state: CashState;
  /** What to tell the rep, when the cash is near or over the limit. */
  words: string | null;
  drops: CashDropView[];
  /** Total taken off the van so far. */
  dropped: number;
}

const round = (n: number): number => Math.round(n * 100) / 100;
const destinationOf = (value: string): DropDestination => (value === 'bank_run' || value === 'office' ? value : 'safe');

/**
 * The cash on a van and the drops that keep it under its limit (docs/architecture/van-sales.md §7). A cash drop is a paid-out of the van's till
 * shift, so the till's expected cash falls by the same amount, and it is recorded in the same transaction with where it went. The limit warns the
 * rep and the supervisor; it never stops a sale.
 */
export class VanCashService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly shifts: ShiftService,
  ) {}

  /** The cash on the van now against its limit, and the drops made. Null for a day with no van till. */
  async forDay(companyId: string, dayId: string): Promise<CashView | null> {
    if (!isId(dayId)) return null;
    const [day] = await this.db.select({ shiftId: vanDays.shiftId, maxCash: vans.maxCash }).from(vanDays).leftJoin(vans, eq(vans.id, vanDays.vanId)).where(and(eq(vanDays.id, dayId), eq(vanDays.companyId, companyId)));
    if (day?.shiftId === null || day === undefined) return null;
    const report = await this.shifts.report(companyId, day.shiftId);
    if (report === null) return null;
    const limit = day.maxCash === null ? null : Number(day.maxCash);
    const rows = await this.db.select().from(vanCashDrops).where(eq(vanCashDrops.dayId, dayId)).orderBy(asc(vanCashDrops.createdAt), asc(vanCashDrops.id));
    const drops = rows.map((r) => {
      const destination = destinationOf(r.destination);
      return { id: r.id, amount: Number(r.amount), destination, destinationWords: DROP_DESTINATION_WORDS[destination], note: r.note, at: r.createdAt.toISOString(), witnessed: r.witnessedAt !== null };
    });
    return { cash: report.expectedCash, limit, state: cashState(report.expectedCash, limit), words: cashWords(report.expectedCash, limit), drops, dropped: round(drops.reduce((n, d) => n + d.amount, 0)) };
  }

  /** Takes cash off the van to the safe, a bank run or the office. */
  async drop(companyId: string, actor: Actor, dayId: string, raw: unknown, maySell: boolean): Promise<void> {
    const own = await ownDay(this.db, companyId, actor, dayId, maySell);
    const read = readCashDrop(raw);
    if (!read.ok) throw new VanSalesError(read.error);
    const view = await this.forDay(companyId, dayId);
    const problem = cashDropProblem({ dayStatus: own.d.status, hasShift: view !== null, cash: view?.cash ?? 0, amount: read.drop.amount });
    if (problem !== null) throw new VanSalesError(problem);
    const shiftId = own.d.shiftId;
    if (shiftId === null) throw new VanSalesError('The van has no till open, so there is no cash to take off it.');
    const d = read.drop;
    const moved = await this.shifts.moveLinked(companyId, { userId: actor.id ?? '', supervisor: false }, shiftId, { kind: 'paid_out', amount: d.amount, reason: `Cash drop to ${DROP_DESTINATION_WORDS[d.destination].toLowerCase()}${d.note === null ? '' : `: ${d.note}`}`.slice(0, 200) }, async (tx, movementId) => {
      await tx.insert(vanCashDrops).values({ companyId, dayId, movementId, amount: d.amount.toFixed(2), destination: d.destination, note: d.note, createdBy: actor.id ?? 'system' });
      await recordDayEvent(tx, this.decisions, companyId, dayId, actor, 'day.cash_dropped', { detail: { amount: d.amount, destination: d.destination } });
    });
    if (!moved.ok) throw new VanSalesError(moved.error);
  }
}
