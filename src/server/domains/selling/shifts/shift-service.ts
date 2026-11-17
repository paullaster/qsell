import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { branches, registers, shiftMovements, shiftSettings, shifts, users } from '@/server/db/drizzle/schema';
import type { Actor } from '@/server/kernel/context';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { ReasonCodes, ReasonInput } from '@/server/kernel/reason-codes/service';
import type { NumberSeriesService } from '@/server/kernel/numbering/service';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { decodeCursor } from '@/server/domains/lookups/request';
import { PAGE_SIZE, pageOf } from '@/server/domains/settings/paging';
import { checkClose, DEFAULT_TOLERANCE, expectedCash, toleranceProblem, varianceOf, type Counted, type ParsedCount, type Tolerance } from './shift-rules';

export class ShiftError extends Error {}

export interface RegisterRow {
  id: string;
  branchId: string;
  branchName: string;
  name: string;
  isActive: boolean;
  /** Who has a shift open on it now, if anyone. */
  openBy: string | null;
}

export interface ShiftReport {
  id: string;
  status: 'open' | 'closed';
  registerName: string;
  branchName: string;
  openedBy: string;
  openedById: string;
  openedAt: string;
  closedBy: string | null;
  closedAt: string | null;
  openingFloat: number;
  openingCounted: Counted[];
  paidIn: number;
  paidOut: number;
  cashSales: number;
  expectedCash: number;
  declaredCash: number | null;
  closingCounted: Counted[];
  variance: number | null;
  varianceReason: string | null;
  zNumber: string | null;
  movements: { kind: 'paid_in' | 'paid_out'; amount: number; reason: string; by: string; at: string }[];
}

export interface ShiftRow {
  id: string;
  registerName: string;
  openedBy: string;
  openedAt: string;
  closedAt: string | null;
  status: 'open' | 'closed';
  variance: number | null;
  zNumber: string | null;
}

type Why = ReasonInput;
const num = (value: string | null): number => (value === null ? 0 : Number(value));

/** Till shifts: registers, opening with a counted float, cash put in and taken out, the X report, closing with a counted declaration, and the Z report. */
export class ShiftService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly reasons: ReasonCodes,
    private readonly numbering: NumberSeriesService,
  ) {}

  // ── Registers and tolerance ────────────────────────────────────────────

  async registerList(companyId: string): Promise<RegisterRow[]> {
    const rows = await this.db
      .select({ id: registers.id, branchId: registers.branchId, branchName: branches.name, name: registers.name, isActive: registers.isActive })
      .from(registers)
      .innerJoin(branches, eq(branches.id, registers.branchId))
      .where(eq(registers.companyId, companyId))
      .orderBy(branches.name, registers.name);
    const open = rows.length === 0 ? [] : await this.db.select({ registerId: shifts.registerId, by: users.name }).from(shifts).innerJoin(users, sql`${users.id}::text = ${shifts.openedBy}`).where(and(eq(shifts.status, 'open'), inArray(shifts.registerId, rows.map((r) => r.id))));
    const openBy = new Map(open.map((o) => [o.registerId, o.by]));
    return rows.map((r) => ({ ...r, openBy: openBy.get(r.id) ?? null }));
  }

  async saveRegister(companyId: string, actor: Actor, input: { id?: string; branchId: string; name: string; isActive: boolean }, reason: Why): Promise<void> {
    const name = input.name.trim();
    if (name.length < 1 || name.length > 60) throw new ShiftError('Give the till a name of up to 60 characters.');
    const [branch] = await this.db.select({ id: branches.id }).from(branches).where(and(eq(branches.id, input.branchId), eq(branches.companyId, companyId))).limit(1);
    if (branch === undefined) throw new ShiftError('Choose one of the company\'s branches.');
    const why = await this.reasons.require(companyId, reason, 'shift_configuration');
    await this.db.transaction(async (tx) => {
      let id = input.id;
      if (id === undefined) {
        const [made] = await tx.insert(registers).values({ companyId, branchId: input.branchId, name, isActive: input.isActive, createdBy: actor.id ?? 'system' }).returning({ id: registers.id }).catch((error: unknown) => {
          if (error instanceof Error && /registers_branch_name_uidx|duplicate key/.test(`${error.message} ${String((error as { cause?: unknown }).cause)}`)) throw new ShiftError('That branch already has a till with that name.');
          throw error;
        });
        id = made?.id;
      } else {
        const open = await tx.select({ id: shifts.id }).from(shifts).where(and(eq(shifts.registerId, id), eq(shifts.status, 'open'))).limit(1);
        if (open.length > 0 && !input.isActive) throw new ShiftError('This till has a shift open. Close it before switching the till off.');
        const changed = await tx.update(registers).set({ name, branchId: input.branchId, isActive: input.isActive, updatedAt: new Date() }).where(and(eq(registers.id, id), eq(registers.companyId, companyId))).returning({ id: registers.id });
        if (changed.length === 0) throw new ShiftError('That till could not be found.');
      }
      await this.decisions.record({ companyId, actor, subject: { type: 'register', id: id ?? '' }, action: input.id === undefined ? 'register.created' : 'register.changed', reason: why, inputs: {}, outcome: { name, branchId: input.branchId, isActive: input.isActive } }, tx);
    });
  }

  async tolerance(companyId: string): Promise<Tolerance> {
    const [row] = await this.db.select().from(shiftSettings).where(eq(shiftSettings.companyId, companyId)).limit(1);
    return row === undefined ? DEFAULT_TOLERANCE : { amount: Number(row.toleranceAmount), percent: Number(row.tolerancePercent) };
  }

  async saveTolerance(companyId: string, actor: Actor, tolerance: Tolerance, reason: Why): Promise<void> {
    const problem = toleranceProblem(tolerance);
    if (problem !== null) throw new ShiftError(problem);
    const why = await this.reasons.require(companyId, reason, 'shift_configuration');
    await this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(shiftSettings).where(eq(shiftSettings.companyId, companyId)).limit(1).for('update');
      const values = { toleranceAmount: String(tolerance.amount), tolerancePercent: String(tolerance.percent), updatedBy: actor.id ?? 'system', updatedAt: new Date() };
      if (before === undefined) await tx.insert(shiftSettings).values({ companyId, ...values });
      else await tx.update(shiftSettings).set({ ...values, version: before.version + 1 }).where(eq(shiftSettings.companyId, companyId));
      await this.decisions.record({ companyId, actor, subject: { type: 'shift_settings', id: companyId }, action: 'shift_settings.changed', reason: why, inputs: before === undefined ? {} : { amount: Number(before.toleranceAmount), percent: Number(before.tolerancePercent) }, outcome: { ...tolerance } }, tx);
    });
  }

  // ── Shifts ─────────────────────────────────────────────────────────────

  /** Cash taken for sales in the shift. Cash sales are recorded against a shift when they are built; until then it is nothing. */
  private async cashSalesOf(_shiftId: string): Promise<number> {
    return await Promise.resolve(0);
  }

  private async figures(shiftId: string, openingFloat: number): Promise<{ paidIn: number; paidOut: number; cashSales: number; expected: number }> {
    const [sums] = await this.db
      .select({ paidIn: sql<string>`COALESCE(SUM(${shiftMovements.amount}) FILTER (WHERE ${shiftMovements.kind} = 'paid_in'), 0)::text`, paidOut: sql<string>`COALESCE(SUM(${shiftMovements.amount}) FILTER (WHERE ${shiftMovements.kind} = 'paid_out'), 0)::text` })
      .from(shiftMovements)
      .where(eq(shiftMovements.shiftId, shiftId));
    const paidIn = Number(sums?.paidIn ?? 0);
    const paidOut = Number(sums?.paidOut ?? 0);
    const cashSales = await this.cashSalesOf(shiftId);
    return { paidIn, paidOut, cashSales, expected: expectedCash({ openingFloat, paidIn, paidOut, cashSales }) };
  }

  /** The open shift of this person, if they have one. */
  async openShiftOf(userId: string): Promise<string | null> {
    const [row] = await this.db.select({ id: shifts.id }).from(shifts).where(and(eq(shifts.openedBy, userId), eq(shifts.status, 'open'))).limit(1);
    return row?.id ?? null;
  }

  /** Registers this person can open a shift on now: active, in their branch (a person with no branch may use any), with no shift open. */
  async registersToOpen(companyId: string, userBranchId: string | null): Promise<RegisterRow[]> {
    return (await this.registerList(companyId)).filter((r) => r.isActive && r.openBy === null && (userBranchId === null || r.branchId === userBranchId));
  }

  async open(companyId: string, who: { userId: string; branchId: string | null }, input: { registerId: string; float: Extract<ParsedCount, { ok: true }> }): Promise<{ ok: true; shiftId: string } | { ok: false; error: string }> {
    const [register] = await this.db.select().from(registers).where(and(eq(registers.id, input.registerId), eq(registers.companyId, companyId))).limit(1);
    if (register?.isActive !== true) return { ok: false, error: 'That till is not available.' };
    if (who.branchId !== null && register.branchId !== who.branchId) return { ok: false, error: 'That till is in another branch.' };
    try {
      const shiftId = await this.db.transaction(async (tx) => {
        const [made] = await tx.insert(shifts).values({ companyId, registerId: register.id, branchId: register.branchId, openedBy: who.userId, openingFloat: String(input.float.total), openingCounted: input.float.counted }).returning({ id: shifts.id });
        if (made === undefined) throw new ShiftError('The shift could not be opened.');
        await this.decisions.record({ companyId, actor: { type: 'user', id: who.userId }, subject: { type: 'shift', id: made.id }, action: 'shift.opened', inputs: {}, outcome: { register: register.name, openingFloat: input.float.total } }, tx);
        return made.id;
      });
      return { ok: true, shiftId };
    } catch (error) {
      const text = `${error instanceof Error ? error.message : ''} ${String((error as { cause?: unknown }).cause)}`;
      if (text.includes('shifts_one_open_per_register_uidx')) return { ok: false, error: 'Someone already has a shift open on that till.' };
      if (text.includes('shifts_one_open_per_person_uidx')) return { ok: false, error: 'You already have a shift open. Close it before opening another.' };
      if (error instanceof ShiftError) return { ok: false, error: error.message };
      throw error;
    }
  }

  /** Cash put into or taken out of the till during the shift, with the reason. Only the person whose shift it is may do it (a supervisor may for anyone's). */
  async move(companyId: string, who: { userId: string; supervisor: boolean }, shiftId: string, input: { kind: 'paid_in' | 'paid_out'; amount: number; reason: string }): Promise<{ ok: true } | { ok: false; error: string }> {
    const reason = input.reason.trim();
    if (reason.length < 3 || reason.length > 200) return { ok: false, error: 'Say why, in 3 to 200 characters.' };
    const [shift] = await this.db.select().from(shifts).where(and(eq(shifts.id, shiftId), eq(shifts.companyId, companyId))).limit(1);
    if (shift === undefined) return { ok: false, error: 'That shift could not be found.' };
    if (shift.status !== 'open') return { ok: false, error: 'That shift is closed.' };
    if (shift.openedBy !== who.userId && !who.supervisor) return { ok: false, error: 'This is another person\'s shift.' };
    if (input.kind === 'paid_out') {
      const f = await this.figures(shift.id, Number(shift.openingFloat));
      if (input.amount > f.expected + 1e-9) return { ok: false, error: `The till holds ${String(f.expected)}: you cannot take out more than that.` };
    }
    try {
      await this.db.insert(shiftMovements).values({ shiftId: shift.id, kind: input.kind, amount: String(input.amount), reason, createdBy: who.userId });
    } catch (error) {
      if (`${error instanceof Error ? error.message : ''} ${String((error as { cause?: unknown }).cause)}`.includes('closed')) return { ok: false, error: 'That shift is closed.' };
      throw error;
    }
    return { ok: true };
  }

  /** The shift as it stands (the X report while it is open, the Z report once closed). */
  async report(companyId: string, shiftId: string): Promise<ShiftReport | null> {
    const [shift] = await this.db.select({ s: shifts, registerName: registers.name, branchName: branches.name }).from(shifts).innerJoin(registers, eq(registers.id, shifts.registerId)).innerJoin(branches, eq(branches.id, shifts.branchId)).where(and(eq(shifts.id, shiftId), eq(shifts.companyId, companyId))).limit(1);
    if (shift === undefined) return null;
    const s = shift.s;
    const movements = await this.db.select().from(shiftMovements).where(eq(shiftMovements.shiftId, s.id)).orderBy(shiftMovements.createdAt);
    const names = await this.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, [...new Set([s.openedBy, ...(s.closedBy === null ? [] : [s.closedBy]), ...movements.map((m) => m.createdBy)].filter((id) => /^[0-9a-f-]{36}$/i.test(id)))]));
    const nameOf = (id: string | null): string => (id === null ? '' : (names.find((n) => n.id === id)?.name ?? id));
    const live = s.status === 'open' ? await this.figures(s.id, Number(s.openingFloat)) : null;
    const kept = s.closingFigures;
    return {
      id: s.id,
      status: s.status,
      registerName: shift.registerName,
      branchName: shift.branchName,
      openedBy: nameOf(s.openedBy),
      openedById: s.openedBy,
      openedAt: s.openedAt.toISOString(),
      closedBy: s.closedBy === null ? null : nameOf(s.closedBy),
      closedAt: s.closedAt?.toISOString() ?? null,
      openingFloat: Number(s.openingFloat),
      openingCounted: s.openingCounted,
      paidIn: live?.paidIn ?? kept?.paidIn ?? 0,
      paidOut: live?.paidOut ?? kept?.paidOut ?? 0,
      cashSales: live?.cashSales ?? kept?.cashSales ?? 0,
      expectedCash: live?.expected ?? num(s.expectedCash),
      declaredCash: s.declaredCash === null ? null : Number(s.declaredCash),
      closingCounted: s.closingCounted,
      variance: s.variance === null ? null : Number(s.variance),
      varianceReason: s.varianceReason,
      zNumber: s.zNumber,
      movements: movements.map((m) => ({ kind: m.kind, amount: Number(m.amount), reason: m.reason, by: nameOf(m.createdBy), at: m.createdAt.toISOString() })),
    };
  }

  /**
   * Closes a shift with the cash counted: works out what the till should hold and the difference, needs a reason for any difference
   * and a supervisor for one beyond the tolerance (or to close another person's shift), numbers the Z report from the gap-free series
   * in the same transaction, and keeps the figures so the report never changes.
   */
  async close(companyId: string, who: { userId: string; supervisor: boolean }, shiftId: string, input: { declared: Extract<ParsedCount, { ok: true }>; reason: string }): Promise<{ ok: true; zNumber: string; variance: number } | { ok: false; error: string }> {
    const tolerance = await this.tolerance(companyId);
    try {
      return await this.db.transaction(async (tx) => {
        const [shift] = await tx.select().from(shifts).where(and(eq(shifts.id, shiftId), eq(shifts.companyId, companyId))).limit(1).for('update');
        if (shift === undefined) return { ok: false as const, error: 'That shift could not be found.' };
        if (shift.status !== 'open') return { ok: false as const, error: 'That shift is already closed.' };
        if (shift.openedBy !== who.userId && !who.supervisor) return { ok: false as const, error: 'This is another person\'s shift: only a supervisor can close it.' };
        const f = await this.figures(shift.id, Number(shift.openingFloat));
        const variance = varianceOf(input.declared.total, f.expected);
        const checked = checkClose({ variance, expected: f.expected, reason: input.reason, tolerance, supervisor: who.supervisor });
        if (!checked.ok) return { ok: false as const, error: checked.error };
        const { number } = await this.numbering.assign('z_report', { companyId, branchId: shift.branchId, date: businessDate(), document: { kind: 'z_report', id: shift.id }, actor: { type: 'user', id: who.userId } }, tx);
        await tx.update(shifts).set({ status: 'closed', closedBy: who.userId, closedAt: new Date(), declaredCash: String(input.declared.total), closingCounted: input.declared.counted, expectedCash: String(f.expected), variance: String(variance), varianceReason: variance === 0 ? null : input.reason.trim(), closingFigures: { paidIn: f.paidIn, paidOut: f.paidOut, cashSales: f.cashSales }, zNumber: number }).where(eq(shifts.id, shift.id));
        await this.decisions.record({ companyId, actor: { type: 'user', id: who.userId }, subject: { type: 'shift', id: shift.id }, action: 'shift.closed', inputs: { expected: f.expected, declared: input.declared.total }, outcome: { variance, kind: checked.kind, zNumber: number, closedByOther: shift.openedBy !== who.userId } }, tx);
        return { ok: true as const, zNumber: number, variance };
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('closed')) return { ok: false, error: 'That shift is already closed.' };
      throw error;
    }
  }

  /** Shifts newest first, 25 a page; `onlyUser` narrows to one person's own (for staff who may not see everyone's). */
  async history(companyId: string, input: { cursor?: string | null; onlyUser?: string }): Promise<{ rows: ShiftRow[]; nextCursor: string | null }> {
    const after = typeof input.cursor === 'string' && input.cursor !== '' ? decodeCursor(input.cursor) : null;
    const rows = await this.db
      .select({ id: shifts.id, registerName: registers.name, openedBy: shifts.openedBy, openedAt: shifts.openedAt, closedAt: shifts.closedAt, status: shifts.status, variance: shifts.variance, zNumber: shifts.zNumber, key: sql<string>`${shifts.openedAt}::text` })
      .from(shifts)
      .innerJoin(registers, eq(registers.id, shifts.registerId))
      .where(and(eq(shifts.companyId, companyId), input.onlyUser === undefined ? undefined : eq(shifts.openedBy, input.onlyUser), after === null ? undefined : sql`(${shifts.openedAt}, ${shifts.id}) < (${after.k}::timestamptz, ${after.id}::uuid)`))
      .orderBy(desc(shifts.openedAt), desc(shifts.id))
      .limit(PAGE_SIZE + 1);
    const names = rows.length === 0 ? [] : await this.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, [...new Set(rows.map((r) => r.openedBy).filter((id) => /^[0-9a-f-]{36}$/i.test(id)))]));
    const page = pageOf(rows, PAGE_SIZE, (r) => ({ k: r.key, id: r.id }));
    return { rows: page.rows.map((r) => ({ id: r.id, registerName: r.registerName, openedBy: names.find((n) => n.id === r.openedBy)?.name ?? r.openedBy, openedAt: r.openedAt.toISOString(), closedAt: r.closedAt?.toISOString() ?? null, status: r.status, variance: r.variance === null ? null : Number(r.variance), zNumber: r.zNumber })), nextCursor: page.nextCursor };
  }
}
