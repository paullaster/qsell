'use server';

import { canPermission, requirePermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { runSetting } from '@/server/domains/settings/action-runner';
import { ReasonError } from '@/server/kernel/reason-codes/service';
import { parseAmount, parseCount, toleranceProblem, type Tolerance } from './shift-rules';
import { ShiftError, type RegisterRow, type ShiftReport, type ShiftRow } from './shift-service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '');

export interface ShiftsScreen {
  mine: ShiftReport | null;
  history: { rows: ShiftRow[]; nextCursor: string | null };
  can: { read: boolean; open: boolean; close: boolean; supervise: boolean };
  tolerance: Tolerance;
}

/** The permission that lets this person see shifts at all, the widest they hold. */
const widest = (can: { read: boolean; open: boolean }): 'shifts:read' | 'shifts:open' | 'shifts:close' => {
  if (can.read) return 'shifts:read';
  return can.open ? 'shifts:open' : 'shifts:close';
};

async function who() {
  const [read, open, close, supervise] = await Promise.all([canPermission('shifts:read'), canPermission('shifts:open'), canPermission('shifts:close'), canPermission('shifts:supervise')]);
  return { read, open, close, supervise };
}

/** Staff: their open shift (if any) with its X report, the history of shifts (everyone's for those who may read them, otherwise their own), and what they may do. */
export async function shiftsScreenAction(): Promise<{ ok: true; data: ShiftsScreen } | { ok: false; error: string }> {
  const can = await who();
  if (!can.read && !can.open && !can.close) return { ok: false, error: 'You do not have permission to see shifts.' };
  const userId = await requirePermission(widest(can));
  try {
    const c = getContainer();
    const company = (await c.companySettings.ensureSeeded()).id;
    const mineId = await c.shifts.openShiftOf(userId);
    return { ok: true, data: { mine: mineId === null ? null : await c.shifts.report(company, mineId), history: await c.shifts.history(company, { ...(can.read ? {} : { onlyUser: userId }) }), can, tolerance: await c.shifts.tolerance(company) } };
  } catch (error) {
    console.error('[shifts] screen', error);
    return { ok: false, error: 'The shifts could not be loaded. Please try again.' };
  }
}

/** Staff: more of the history of shifts. */
export async function shiftHistoryAction(raw: unknown): Promise<{ ok: true; data: { rows: ShiftRow[]; nextCursor: string | null } } | { ok: false; error: string }> {
  const can = await who();
  if (!can.read && !can.open && !can.close) return { ok: false, error: 'You do not have permission to see shifts.' };
  const userId = await requirePermission(widest(can));
  try {
    const c = getContainer();
    return { ok: true, data: await c.shifts.history((await c.companySettings.ensureSeeded()).id, { cursor: typeof obj(raw).cursor === 'string' ? (obj(raw).cursor as string) : null, ...(can.read ? {} : { onlyUser: userId }) }) };
  } catch (error) {
    console.error('[shifts] history', error);
    return { ok: false, error: 'The shifts could not be loaded. Please try again.' };
  }
}

/** Staff: one shift's report (X while it is open, Z once closed). A person without the right to read every shift sees only their own. */
export async function shiftReportAction(shiftId: unknown): Promise<{ ok: true; data: ShiftReport | null } | { ok: false; error: string }> {
  const can = await who();
  if (!can.read && !can.open && !can.close) return { ok: false, error: 'You do not have permission to see shifts.' };
  const userId = await requirePermission(widest(can));
  if (typeof shiftId !== 'string' || !UUID.test(shiftId)) return { ok: true, data: null };
  try {
    const c = getContainer();
    const report = await c.shifts.report((await c.companySettings.ensureSeeded()).id, shiftId);
    return { ok: true, data: report !== null && (can.read || report.openedById === userId) ? report : null };
  } catch (error) {
    console.error('[shifts] report', error);
    return { ok: false, error: 'The report could not be loaded. Please try again.' };
  }
}

/** Staff: opens a shift on a till with the float counted. */
export async function openShiftAction(raw: unknown): Promise<{ ok: true; data: { shiftId: string } } | { ok: false; error: string }> {
  const userId = await requirePermission('shifts:open');
  const input = obj(raw);
  const registerId = text(input.registerId, 40);
  if (!UUID.test(registerId)) return { ok: false, error: 'Choose the till.' };
  const float = parseCount(input.float, 'float');
  if (!float.ok) return { ok: false, error: float.error };
  try {
    const c = getContainer();
    const opened = await c.shifts.open((await c.companySettings.ensureSeeded()).id, { userId, branchId: await c.salesOrders.branchOf(userId) }, { registerId, float });
    return opened.ok ? { ok: true, data: { shiftId: opened.shiftId } } : { ok: false, error: opened.error };
  } catch (error) {
    console.error('[shifts] open', error);
    return { ok: false, error: 'The shift could not be opened just now. Please try again.' };
  }
}

/** Staff: puts cash into the till or takes it out, with the reason. */
export async function shiftMovementAction(raw: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  const userId = await requirePermission('shifts:open');
  const input = obj(raw);
  const shiftId = text(input.shiftId, 40);
  const amount = parseAmount(input.amount);
  if (!UUID.test(shiftId)) return { ok: false, error: 'That shift could not be found.' };
  if (input.kind !== 'paid_in' && input.kind !== 'paid_out') return { ok: false, error: 'Say whether cash is put in or taken out.' };
  if (amount === null) return { ok: false, error: 'Give an amount of more than nothing, with at most two decimals.' };
  try {
    const c = getContainer();
    return await c.shifts.move((await c.companySettings.ensureSeeded()).id, { userId, supervisor: await canPermission('shifts:supervise') }, shiftId, { kind: input.kind, amount, reason: text(input.reason, 200) });
  } catch (error) {
    console.error('[shifts] movement', error);
    return { ok: false, error: 'The cash could not be recorded just now. Please try again.' };
  }
}

/** Staff: closes a shift with the cash counted. A difference needs its reason; one beyond the company's tolerance (or another person's shift) needs a supervisor. */
export async function closeShiftAction(raw: unknown): Promise<{ ok: true; data: { zNumber: string; variance: number } } | { ok: false; error: string }> {
  const supervisor = await canPermission('shifts:supervise');
  const userId = await requirePermission(supervisor ? 'shifts:supervise' : 'shifts:close');
  const input = obj(raw);
  const shiftId = text(input.shiftId, 40);
  if (!UUID.test(shiftId)) return { ok: false, error: 'That shift could not be found.' };
  const declared = parseCount(input.declared, 'cash in the till');
  if (!declared.ok) return { ok: false, error: declared.error };
  try {
    const c = getContainer();
    const closed = await c.shifts.close((await c.companySettings.ensureSeeded()).id, { userId, supervisor }, shiftId, { declared, reason: text(input.reason, 200) });
    return closed.ok ? { ok: true, data: { zNumber: closed.zNumber, variance: closed.variance } } : { ok: false, error: closed.error };
  } catch (error) {
    console.error('[shifts] close', error);
    return { ok: false, error: 'The shift could not be closed just now. Please try again.' };
  }
}

// ── Registers and tolerance (Settings → Registers) ───────────────────────

const friendly = (error: unknown): string | null => (error instanceof ShiftError || error instanceof ReasonError ? error.message : null);
const PATHS = ['/admin/settings/registers'];
const reasonOf = (value: unknown): { code: string; text?: string } => {
  const r = obj(value);
  const code = typeof r.code === 'string' ? r.code : '';
  return typeof r.text === 'string' ? { code, text: r.text } : { code };
};

export interface RegistersScreen {
  registers: RegisterRow[];
  tolerance: Tolerance;
}

export async function registersScreenAction() {
  return await runSetting('registers:manage', async ({ companyId }): Promise<RegistersScreen> => ({ registers: await getContainer().shifts.registerList(companyId), tolerance: await getContainer().shifts.tolerance(companyId) }), { friendly });
}

export async function saveRegisterAction(raw: unknown, reason: unknown) {
  return await runSetting(
    'registers:manage',
    async ({ companyId, userId }): Promise<RegistersScreen> => {
      const c = getContainer();
      await c.reasonCodes.ensureSystemReasons(companyId);
      const input = obj(raw);
      const branchId = text(input.branchId, 40);
      if (!UUID.test(branchId)) throw new ShiftError('Choose the branch the till is in.');
      const id = typeof input.id === 'string' && UUID.test(input.id) ? input.id : undefined;
      await c.shifts.saveRegister(companyId, { type: 'user', id: userId }, { ...(id === undefined ? {} : { id }), branchId, name: text(input.name, 60), isActive: input.isActive !== false }, reasonOf(reason));
      return { registers: await c.shifts.registerList(companyId), tolerance: await c.shifts.tolerance(companyId) };
    },
    { paths: PATHS, friendly },
  );
}

export async function saveToleranceAction(raw: unknown, reason: unknown) {
  return await runSetting(
    'registers:manage',
    async ({ companyId, userId }): Promise<RegistersScreen> => {
      const c = getContainer();
      await c.reasonCodes.ensureSystemReasons(companyId);
      const input = obj(raw);
      const tolerance = { amount: typeof input.amount === 'number' ? input.amount : Number.NaN, percent: typeof input.percent === 'number' ? input.percent : Number.NaN };
      const problem = toleranceProblem(tolerance);
      if (problem !== null) throw new ShiftError(problem);
      await c.shifts.saveTolerance(companyId, { type: 'user', id: userId }, tolerance, reasonOf(reason));
      return { registers: await c.shifts.registerList(companyId), tolerance: await c.shifts.tolerance(companyId) };
    },
    { paths: PATHS, friendly },
  );
}
