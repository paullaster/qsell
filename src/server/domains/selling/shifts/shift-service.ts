import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { branches, counterReturns, orders, orderTenders, registers, shiftCloseRequests, shiftMovements, shiftSettings, shifts, users } from '@/server/db/drizzle/schema';
import type { Actor } from '@/server/kernel/context';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { ReasonCodes, ReasonInput } from '@/server/kernel/reason-codes/service';
import type { NumberSeriesService } from '@/server/kernel/numbering/service';
import type { ApprovalEngine, Tx } from '@/server/kernel/approvals/engine';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { decodeCursor } from '@/server/domains/lookups/request';
import { PAGE_SIZE, pageOf } from '@/server/domains/settings/paging';
import { checkClose, DEFAULT_TOLERANCE, expectedCash, toleranceProblem, varianceOf, type Counted, type ParsedCount, type SupervisorClose, type Tolerance } from './shift-rules';

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
  status: 'open' | 'closing' | 'closed';
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
  /** While the close waits in the approval queue: what was counted and why, and who asked. */
  /** What counter sales took in this shift. */
  takings: { count: number; cash: number; mobileMoney: number; card: number; refunds: number; cashRefunds: number };
  closeRequest: { requestedBy: string; requestedAt: string; declaredCash: number; variance: number; reason: string } | null;
  movements: { kind: 'paid_in' | 'paid_out'; amount: number; reason: string; by: string; at: string }[];
}

export interface ShiftRow {
  id: string;
  registerName: string;
  openedBy: string;
  openedAt: string;
  closedAt: string | null;
  status: 'open' | 'closing' | 'closed';
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
    private readonly approvals: ApprovalEngine,
  ) {}

  // ── Registers and tolerance ────────────────────────────────────────────

  async registerList(companyId: string): Promise<RegisterRow[]> {
    const rows = await this.db
      .select({ id: registers.id, branchId: registers.branchId, branchName: branches.name, name: registers.name, isActive: registers.isActive })
      .from(registers)
      .innerJoin(branches, eq(branches.id, registers.branchId))
      .where(eq(registers.companyId, companyId))
      .orderBy(branches.name, registers.name);
    const open = rows.length === 0 ? [] : await this.db.select({ registerId: shifts.registerId, by: users.name }).from(shifts).innerJoin(users, sql`${users.id}::text = ${shifts.openedBy}`).where(and(inArray(shifts.status, ['open', 'closing']), inArray(shifts.registerId, rows.map((r) => r.id))));
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
        const open = await tx.select({ id: shifts.id }).from(shifts).where(and(eq(shifts.registerId, id), inArray(shifts.status, ['open', 'closing']))).limit(1);
        if (open.length > 0 && !input.isActive) throw new ShiftError('This till has a shift open. Close it before switching the till off.');
        const changed = await tx.update(registers).set({ name, branchId: input.branchId, isActive: input.isActive, updatedAt: new Date() }).where(and(eq(registers.id, id), eq(registers.companyId, companyId))).returning({ id: registers.id });
        if (changed.length === 0) throw new ShiftError('That till could not be found.');
      }
      await this.decisions.record({ companyId, actor, subject: { type: 'register', id: id ?? '' }, action: input.id === undefined ? 'register.created' : 'register.changed', reason: why, inputs: {}, outcome: { name, branchId: input.branchId, isActive: input.isActive } }, tx);
    });
  }

  async settings(companyId: string): Promise<{ tolerance: Tolerance; supervisorClose: SupervisorClose }> {
    const [row] = await this.db.select().from(shiftSettings).where(eq(shiftSettings.companyId, companyId)).limit(1);
    return row === undefined ? { tolerance: DEFAULT_TOLERANCE, supervisorClose: 'direct' } : { tolerance: { amount: Number(row.toleranceAmount), percent: Number(row.tolerancePercent) }, supervisorClose: row.supervisorClose };
  }

  async tolerance(companyId: string): Promise<Tolerance> {
    return (await this.settings(companyId)).tolerance;
  }

  async saveSettings(companyId: string, actor: Actor, next: { tolerance: Tolerance; supervisorClose: SupervisorClose }, reason: Why): Promise<void> {
    const problem = toleranceProblem(next.tolerance);
    if (problem !== null) throw new ShiftError(problem);
    const why = await this.reasons.require(companyId, reason, 'shift_configuration');
    await this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(shiftSettings).where(eq(shiftSettings.companyId, companyId)).limit(1).for('update');
      const values = { toleranceAmount: String(next.tolerance.amount), tolerancePercent: String(next.tolerance.percent), supervisorClose: next.supervisorClose, updatedBy: actor.id ?? 'system', updatedAt: new Date() };
      if (before === undefined) await tx.insert(shiftSettings).values({ companyId, ...values });
      else await tx.update(shiftSettings).set({ ...values, version: before.version + 1 }).where(eq(shiftSettings.companyId, companyId));
      await this.decisions.record({ companyId, actor, subject: { type: 'shift_settings', id: companyId }, action: 'shift_settings.changed', reason: why, inputs: before === undefined ? {} : { amount: Number(before.toleranceAmount), percent: Number(before.tolerancePercent), supervisorClose: before.supervisorClose }, outcome: { ...next.tolerance, supervisorClose: next.supervisorClose } }, tx);
    });
  }

  // ── Shifts ─────────────────────────────────────────────────────────────

  /** What counter sales took in the shift, by how it was paid (net of change), how many sales, and the cash handed back for returns. Reads the tenders of the orders that name the shift. */
  async takings(shiftId: string, w: Pick<DrizzleDb, 'select'> = this.db): Promise<{ count: number; cash: number; mobileMoney: number; card: number; refunds: number; cashRefunds: number }> {
    const [row] = await w
      .select({
        count: sql<string>`COUNT(DISTINCT ${orderTenders.orderId})::text`,
        cash: sql<string>`COALESCE(SUM(${orderTenders.amount}) FILTER (WHERE ${orderTenders.methodKind} = 'cash'), 0)::text`,
        mobileMoney: sql<string>`COALESCE(SUM(${orderTenders.amount}) FILTER (WHERE ${orderTenders.methodKind} = 'mobile_money'), 0)::text`,
        card: sql<string>`COALESCE(SUM(${orderTenders.amount}) FILTER (WHERE ${orderTenders.methodKind} = 'card'), 0)::text`,
      })
      .from(orderTenders)
      .innerJoin(orders, eq(orders.id, orderTenders.orderId))
      .where(and(eq(orders.shiftId, shiftId), eq(orderTenders.kind, 'payment_method')));
    const [back] = await w.select({ n: sql<string>`COUNT(*)::text`, cash: sql<string>`COALESCE(SUM(${counterReturns.cashPaid}), 0)::text` }).from(counterReturns).where(and(eq(counterReturns.shiftId, shiftId), sql`${counterReturns.cashPaid} > 0`));
    return { count: Number(row?.count ?? 0), cash: Number(row?.cash ?? 0), mobileMoney: Number(row?.mobileMoney ?? 0), card: Number(row?.card ?? 0), refunds: Number(back?.n ?? 0), cashRefunds: Number(back?.cash ?? 0) };
  }

  /** The open shift this person may ring a sale into, or why there is none. */
  async openForSale(companyId: string, userId: string): Promise<{ ok: true; shiftId: string; branchId: string } | { ok: false; error: string }> {
    const [shift] = await this.db.select().from(shifts).where(and(eq(shifts.companyId, companyId), eq(shifts.openedBy, userId), inArray(shifts.status, ['open', 'closing']))).limit(1);
    if (shift === undefined) return { ok: false, error: 'Open a shift on a till before selling at the counter.' };
    if (shift.status === 'closing') return { ok: false, error: 'Your shift is waiting for its close to be approved: no sale can be rung up in it. Withdraw the close on the Shifts screen to sell again.' };
    return { ok: true, shiftId: shift.id, branchId: shift.branchId };
  }

  private async figures(shiftId: string, openingFloat: number): Promise<{ paidIn: number; paidOut: number; cashSales: number; cashRefunds: number; expected: number }> {
    const [sums] = await this.db
      .select({ paidIn: sql<string>`COALESCE(SUM(${shiftMovements.amount}) FILTER (WHERE ${shiftMovements.kind} = 'paid_in'), 0)::text`, paidOut: sql<string>`COALESCE(SUM(${shiftMovements.amount}) FILTER (WHERE ${shiftMovements.kind} = 'paid_out'), 0)::text` })
      .from(shiftMovements)
      .where(eq(shiftMovements.shiftId, shiftId));
    const paidIn = Number(sums?.paidIn ?? 0);
    const paidOut = Number(sums?.paidOut ?? 0);
    const taken = await this.takings(shiftId);
    const cashSales = taken.cash;
    const cashRefunds = taken.cashRefunds;
    return { paidIn, paidOut, cashSales, cashRefunds, expected: expectedCash({ openingFloat, paidIn, paidOut, cashSales, cashRefunds }) };
  }

  /** The open shift of this person, if they have one. */
  async openShiftOf(userId: string): Promise<string | null> {
    const [row] = await this.db.select({ id: shifts.id }).from(shifts).where(and(eq(shifts.openedBy, userId), inArray(shifts.status, ['open', 'closing']))).limit(1);
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
    if (shift.status === 'closing') return { ok: false, error: 'This shift is waiting for its close to be approved: no cash can be added or taken out until it is decided.' };
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
    const [asked] = s.status === 'closing' ? await this.db.select().from(shiftCloseRequests).where(and(eq(shiftCloseRequests.shiftId, s.id), eq(shiftCloseRequests.status, 'pending'))).limit(1) : [];
    const askedBy = asked === undefined ? [] : [asked.requestedBy];
    const names = await this.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, [...new Set([s.openedBy, ...askedBy, ...(s.closedBy === null ? [] : [s.closedBy]), ...movements.map((m) => m.createdBy)].filter((id) => /^[0-9a-f-]{36}$/i.test(id)))]));
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
      takings: await this.takings(s.id),
      closeRequest: asked === undefined ? null : { requestedBy: nameOf(asked.requestedBy), requestedAt: asked.createdAt.toISOString(), declaredCash: Number(asked.declaredCash), variance: Number(asked.variance), reason: asked.varianceReason },
      movements: movements.map((m) => ({ kind: m.kind, amount: Number(m.amount), reason: m.reason, by: nameOf(m.createdBy), at: m.createdAt.toISOString() })),
    };
  }

  /**
   * Closes a shift with the cash counted: works out what the till should hold and the difference, needs a reason for any difference,
   * and for one beyond the allowance either a supervisor on the spot or, when the company chose the approval queue, a decision in it
   * (the shift waits as `closing`, with no cash moving, until it is decided). The Z report is numbered from the gap-free series in the
   * same transaction as the close, and the figures are kept so the report never changes.
   */
  async close(companyId: string, who: { userId: string; supervisor: boolean }, shiftId: string, input: { declared: Extract<ParsedCount, { ok: true }>; reason: string }): Promise<{ ok: true; pending: false; zNumber: string; variance: number } | { ok: true; pending: true; variance: number } | { ok: false; error: string }> {
    const { tolerance, supervisorClose } = await this.settings(companyId);
    try {
      return await this.db.transaction(async (tx) => {
        const [shift] = await tx.select().from(shifts).where(and(eq(shifts.id, shiftId), eq(shifts.companyId, companyId))).limit(1).for('update');
        if (shift === undefined) return { ok: false as const, error: 'That shift could not be found.' };
        if (shift.status === 'closing') return { ok: false as const, error: 'This shift\'s close is waiting for approval.' };
        if (shift.status !== 'open') return { ok: false as const, error: 'That shift is already closed.' };
        const own = shift.openedBy === who.userId;
        if (!own && !who.supervisor) return { ok: false as const, error: 'This is another person\'s shift: only a supervisor can close it.' };
        const [unfinished] = await tx.select({ n: sql<string>`COUNT(*)::text` }).from(orders).where(and(eq(orders.shiftId, shift.id), eq(orders.salesModule, 'pos_cash_sale'), sql`${orders.paymentStatus} NOT IN ('paid', 'reconciled', 'refunded', 'partially_refunded')`, sql`${orders.status} NOT IN ('cancelled', 'failed')`));
        if (Number(unfinished?.n ?? 0) > 0) return { ok: false as const, error: `${unfinished?.n ?? '0'} sale(s) rung up in this shift are still waiting for their payment to be recorded. Finish or cancel them on the Cash Sales screen before closing.` };
        const f = await this.figures(shift.id, Number(shift.openingFloat));
        const variance = varianceOf(input.declared.total, f.expected);
        const checked = checkClose({ variance, expected: f.expected, reason: input.reason, tolerance, supervisor: who.supervisor, mode: supervisorClose, ownShift: own });
        if (!checked.ok) return { ok: false as const, error: checked.error };
        const figures = { paidIn: f.paidIn, paidOut: f.paidOut, cashSales: f.cashSales, cashRefunds: f.cashRefunds };
        const closing = { shift, closedBy: who.userId, declared: input.declared.total, counted: input.declared.counted, expected: f.expected, variance, reason: variance === 0 ? null : input.reason.trim(), figures };
        if (checked.route === 'close') {
          const zNumber = await this.finalize(tx, { ...closing, kind: checked.kind, how: 'on_the_spot' });
          return { ok: true as const, pending: false as const, zNumber, variance };
        }
        // Held for approval: the count is kept, the shift stops taking cash, and the queue decides.
        const [request] = await tx.insert(shiftCloseRequests).values({ shiftId: shift.id, requestedBy: who.userId, declaredCash: String(input.declared.total), closingCounted: input.declared.counted, expectedCash: String(f.expected), variance: String(variance), varianceReason: input.reason.trim(), closingFigures: figures }).returning({ id: shiftCloseRequests.id });
        if (request === undefined) throw new ShiftError('The close could not be asked for.');
        await tx.update(shifts).set({ status: 'closing' }).where(eq(shifts.id, shift.id));
        const outcome = await this.approvals.submit({ companyId, trigger: 'shift.close_requested', documentId: shift.id, branchId: shift.branchId, requestedBy: who.userId, amount: Math.abs(variance), snapshot: { variance, absoluteVariance: Math.abs(variance), expectedCash: f.expected, registerId: shift.registerId } }, tx);
        if (!outcome.required) throw new ShiftError('This difference is beyond what the company allows a till to be out by, so closing the shift needs approval, but no approval workflow covers it. Ask an administrator to set one up for closing till shifts, or to let a supervisor close them directly (Settings, Registers).');
        await this.decisions.record({ companyId, actor: { type: 'user', id: who.userId }, subject: { type: 'shift', id: shift.id }, action: 'shift.close_requested', inputs: { expected: f.expected, declared: input.declared.total }, outcome: { variance, reason: input.reason.trim() } }, tx);
        if (outcome.released) {
          const zNumber = await this.finalize(tx, { ...closing, reason: input.reason.trim(), kind: 'beyond', how: 'approval', request: request.id });
          return { ok: true as const, pending: false as const, zNumber, variance };
        }
        return { ok: true as const, pending: true as const, variance };
      });
    } catch (error) {
      if (error instanceof ShiftError) return { ok: false, error: error.message };
      if (error instanceof Error && error.message.includes('closed')) return { ok: false, error: 'That shift is already closed.' };
      throw error;
    }
  }

  /** Writes the close itself: the Z number, the kept figures and the decision-log entry, in the caller's transaction. */
  private async finalize(tx: Tx, c: { shift: typeof shifts.$inferSelect; closedBy: string; declared: number; counted: Counted[]; expected: number; variance: number; reason: string | null; figures: { paidIn: number; paidOut: number; cashSales: number }; kind: string; how: 'on_the_spot' | 'approval'; request?: string }): Promise<string> {
    const { number } = await this.numbering.assign('z_report', { companyId: c.shift.companyId, branchId: c.shift.branchId, date: businessDate(), document: { kind: 'z_report', id: c.shift.id }, actor: { type: 'user', id: c.closedBy } }, tx);
    await tx.update(shifts).set({ status: 'closed', closedBy: c.closedBy, closedAt: new Date(), declaredCash: String(c.declared), closingCounted: c.counted, expectedCash: String(c.expected), variance: String(c.variance), varianceReason: c.reason, closingFigures: c.figures, zNumber: number }).where(eq(shifts.id, c.shift.id));
    if (c.request !== undefined) await tx.update(shiftCloseRequests).set({ status: 'approved', decidedAt: new Date() }).where(eq(shiftCloseRequests.id, c.request));
    await this.decisions.record({ companyId: c.shift.companyId, actor: { type: 'user', id: c.closedBy }, subject: { type: 'shift', id: c.shift.id }, action: 'shift.closed', inputs: { expected: c.expected, declared: c.declared }, outcome: { variance: c.variance, kind: c.kind, zNumber: number, how: c.how, closedByOther: c.shift.openedBy !== c.closedBy } }, tx);
    return number;
  }

  private async pendingRequest(tx: Tx, shiftId: string) {
    const [shift] = await tx.select().from(shifts).where(eq(shifts.id, shiftId)).limit(1).for('update');
    const [request] = await tx.select().from(shiftCloseRequests).where(and(eq(shiftCloseRequests.shiftId, shiftId), eq(shiftCloseRequests.status, 'pending'))).limit(1).for('update');
    return { shift, request };
  }

  /** The approval queue approved the close: the shift closes from exactly the count and figures that were asked about. */
  async onCloseApproved(tx: Tx, shiftId: string): Promise<void> {
    const { shift, request } = await this.pendingRequest(tx, shiftId);
    if (shift === undefined || request === undefined) return;
    if (shift.status !== 'closing') return;
    await this.finalize(tx, { shift, closedBy: request.requestedBy, declared: Number(request.declaredCash), counted: request.closingCounted, expected: Number(request.expectedCash), variance: Number(request.variance), reason: request.varianceReason, figures: request.closingFigures, kind: 'beyond', how: 'approval', request: request.id });
  }

  /** Rejected or withdrawn: the shift is open again so the till can be recounted, and the request is kept with what was said. */
  private async reopen(tx: Tx, shiftId: string, status: 'rejected' | 'canceled', note: string): Promise<void> {
    const { shift, request } = await this.pendingRequest(tx, shiftId);
    if (shift === undefined || request === undefined) return;
    await tx.update(shiftCloseRequests).set({ status, decisionNote: note, decidedAt: new Date() }).where(eq(shiftCloseRequests.id, request.id));
    if (shift.status === 'closing') await tx.update(shifts).set({ status: 'open' }).where(eq(shifts.id, shift.id));
    await this.decisions.record({ companyId: shift.companyId, actor: { type: 'system', id: null }, subject: { type: 'shift', id: shift.id }, action: status === 'rejected' ? 'shift.close_rejected' : 'shift.close_withdrawn', inputs: { declared: Number(request.declaredCash), variance: Number(request.variance) }, outcome: { note } }, tx);
  }

  async onCloseRejected(tx: Tx, shiftId: string, info: { reasonCode: string; comment: string }): Promise<void> {
    await this.reopen(tx, shiftId, 'rejected', `${info.reasonCode.replace(/_/g, ' ')}${info.comment.trim() === '' ? '' : `: ${info.comment.trim()}`}`);
  }

  async onCloseCanceled(tx: Tx, shiftId: string): Promise<void> {
    await this.reopen(tx, shiftId, 'canceled', 'The request was withdrawn.');
  }

  /** The person who asked for the close (or a supervisor) withdraws it, so the shift is open again for a recount. */
  async withdrawClose(companyId: string, who: { userId: string; supervisor: boolean }, shiftId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      return await this.db.transaction(async (tx) => {
        const [request] = await tx.select({ r: shiftCloseRequests }).from(shiftCloseRequests).innerJoin(shifts, eq(shifts.id, shiftCloseRequests.shiftId)).where(and(eq(shiftCloseRequests.shiftId, shiftId), eq(shifts.companyId, companyId), eq(shiftCloseRequests.status, 'pending'))).limit(1);
        if (request === undefined) return { ok: false as const, error: 'No close is waiting for approval on that shift.' };
        const submissions = await this.approvals.forDocument(companyId, 'shift_close', shiftId);
        const pending = submissions.find((r) => r.status === 'pending');
        if (pending === undefined) return { ok: false as const, error: 'No close is waiting for approval on that shift.' };
        await this.approvals.cancel(pending.submissionId, { userId: who.userId, isAdmin: who.supervisor }, { text: 'Withdrawn from the shifts screen.' }, tx);
        return { ok: true as const };
      });
    } catch (error) {
      if (error instanceof Error && 'code' in error) return { ok: false, error: error.message };
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
