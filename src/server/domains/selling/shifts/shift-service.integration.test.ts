import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { getContainer } from '@/server/di/container';
import type { drizzleDb } from '@/server/db/drizzle/client';
import type * as schemaModule from '@/server/db/drizzle/schema';
import { parseCount } from './shift-rules';

/**
 * Till shifts against a real database: tills, opening with a counted float, cash in and out, the X report, closing with a counted
 * declaration, the difference and who may close, the gap-free Z number, and a closed shift that nothing can change.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (url !== undefined && url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === undefined || url === '')('till shifts (database)', () => {
  let c: ReturnType<typeof getContainer>;
  let db: typeof drizzleDb;
  let schema: typeof schemaModule;
  let companyId: string;
  let branchId: string;
  let otherBranchId: string;
  const actor = { type: 'user' as const, id: 'shift-test' };
  const reason = { code: 'POLICY_CHANGE' };

  const user = async (name: string) => {
    const [row] = await db.insert(schema.users).values({ email: `${name}-${randomUUID().slice(0, 8)}@sh.test`, passwordHash: 'x', name, role: 'manager' }).returning();
    if (row === undefined) throw new Error('no user');
    return row;
  };
  const counted = (total: number) => {
    const r = parseCount({ total }, 'cash');
    if (!r.ok) throw new Error(r.error);
    return r;
  };
  const till = async (name = `Till ${randomUUID().slice(0, 6)}`, branch = branchId) => {
    await c.shifts.saveRegister(companyId, actor, { branchId: branch, name, isActive: true }, reason);
    const found = (await c.shifts.registerList(companyId)).find((r) => r.name === name && r.branchId === branch);
    if (found === undefined) throw new Error('till not made');
    return found;
  };
  const open = async (person: { id: string }, registerId: string, float = 5000) => {
    const opened = await c.shifts.open(companyId, { userId: person.id, branchId: null }, { registerId, float: counted(float) });
    if (!opened.ok) throw new Error(opened.error);
    return opened.shiftId;
  };

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    const { branch } = await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Shifts Co');
    branchId = ((await c.branches.getDefault(companyId)) ?? branch).id;
    const [other] = await db.insert(schema.branches).values({ companyId, code: `SH${randomUUID().slice(0, 6)}`, name: 'Other shift branch' }).returning();
    otherBranchId = other?.id ?? '';
  });

  it('sets up tills with a name per branch, records who and why, and shows who has a shift on each', async () => {
    const frontName = `Front till ${randomUUID().slice(0, 6)}`;
    const one = await till(frontName);
    expect(one).toMatchObject({ name: frontName, branchId, isActive: true, openBy: null });
    await expect(c.shifts.saveRegister(companyId, actor, { branchId, name: frontName, isActive: true }, reason)).rejects.toThrow('already has a till with that name');
    await expect(c.shifts.saveRegister(companyId, actor, { branchId, name: '   ', isActive: true }, reason)).rejects.toThrow('Give the till a name');
    await expect(c.shifts.saveRegister(companyId, actor, { branchId: randomUUID(), name: 'Ghost', isActive: true }, reason)).rejects.toThrow('one of the company');
    await expect(c.shifts.saveRegister(companyId, actor, { branchId, name: 'Nope', isActive: true }, { code: 'NO_SUCH_REASON' })).rejects.toThrow();
    const cashier = await user('cashier');
    await open(cashier, one.id);
    expect((await c.shifts.registerList(companyId)).find((r) => r.id === one.id)?.openBy).toBe('cashier');
    await expect(c.shifts.saveRegister(companyId, actor, { id: one.id, branchId, name: frontName, isActive: false }, reason)).rejects.toThrow('has a shift open');
    const entries = await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectType, 'register'));
    expect(entries.map((e) => e.action)).toContain('register.created');
  });

  it('opens a shift with the float counted, one per till and one per person, in the person\'s own branch', async () => {
    const a = await till();
    const b = await till();
    const alice = await user('alice');
    const bob = await user('bob');
    const first = await c.shifts.open(companyId, { userId: alice.id, branchId: null }, { registerId: a.id, float: parseCount({ counted: [{ value: 1000, count: 3 }, { value: 500, count: 4 }] }, 'float') as never });
    expect(first.ok).toBe(true);
    const report = first.ok ? await c.shifts.report(companyId, first.shiftId) : null;
    expect(report).toMatchObject({ status: 'open', openingFloat: 5000, openingCounted: [{ value: 1000, count: 3 }, { value: 500, count: 4 }], expectedCash: 5000, openedBy: 'alice' });
    expect(await c.shifts.openShiftOf(alice.id)).toBe(first.ok ? first.shiftId : null);
    expect(await c.shifts.open(companyId, { userId: bob.id, branchId: null }, { registerId: a.id, float: counted(100) })).toEqual({ ok: false, error: 'Someone already has a shift open on that till.' });
    expect(await c.shifts.open(companyId, { userId: alice.id, branchId: null }, { registerId: b.id, float: counted(100) })).toEqual({ ok: false, error: 'You already have a shift open. Close it before opening another.' });
    expect(await c.shifts.open(companyId, { userId: bob.id, branchId }, { registerId: (await till(undefined, otherBranchId)).id, float: counted(100) })).toEqual({ ok: false, error: 'That till is in another branch.' });
    expect((await c.shifts.registersToOpen(companyId, branchId)).map((r) => r.id)).toContain(b.id);
    expect((await c.shifts.registersToOpen(companyId, branchId)).map((r) => r.id)).not.toContain(a.id);
    expect(await c.shifts.open(companyId, { userId: bob.id, branchId: null }, { registerId: randomUUID(), float: counted(1) })).toEqual({ ok: false, error: 'That till is not available.' });
  });

  it('puts cash in and takes it out with a reason, shows what the till should hold, and refuses taking out more than it holds', async () => {
    const t = await till();
    const person = await user('mover');
    const stranger = await user('stranger');
    const shiftId = await open(person, t.id, 5000);
    const sup = { userId: stranger.id, supervisor: true };
    expect(await c.shifts.move(companyId, { userId: person.id, supervisor: false }, shiftId, { kind: 'paid_in', amount: 300, reason: 'change from the bank' })).toEqual({ ok: true });
    expect(await c.shifts.move(companyId, { userId: person.id, supervisor: false }, shiftId, { kind: 'paid_out', amount: 120.5, reason: 'bought milk' })).toEqual({ ok: true });
    const report = await c.shifts.report(companyId, shiftId);
    expect(report).toMatchObject({ paidIn: 300, paidOut: 120.5, expectedCash: 5179.5 });
    expect(report?.movements.map((m) => [m.kind, m.amount, m.reason])).toEqual([['paid_in', 300, 'change from the bank'], ['paid_out', 120.5, 'bought milk']]);
    expect(await c.shifts.move(companyId, { userId: person.id, supervisor: false }, shiftId, { kind: 'paid_out', amount: 6000, reason: 'too much' })).toEqual({ ok: false, error: 'The till holds 5179.5: you cannot take out more than that.' });
    expect(await c.shifts.move(companyId, { userId: person.id, supervisor: false }, shiftId, { kind: 'paid_in', amount: 5, reason: '' })).toEqual({ ok: false, error: 'Say why, in 3 to 200 characters.' });
    expect(await c.shifts.move(companyId, { userId: stranger.id, supervisor: false }, shiftId, { kind: 'paid_in', amount: 5, reason: 'not mine' })).toEqual({ ok: false, error: 'This is another person\'s shift.' });
    expect(await c.shifts.move(companyId, sup, shiftId, { kind: 'paid_in', amount: 5, reason: 'supervisor adds' })).toEqual({ ok: true });
  });

  it('closes a shift with the cash counted: the difference within tolerance needs a reason, the Z report is numbered once, and the figures are kept', async () => {
    const t = await till();
    const person = await user('closer');
    const shiftId = await open(person, t.id, 5000);
    await c.shifts.move(companyId, { userId: person.id, supervisor: false }, shiftId, { kind: 'paid_in', amount: 500, reason: 'float top-up' });
    const noReason = await c.shifts.close(companyId, { userId: person.id, supervisor: false }, shiftId, { declared: counted(5450), reason: '' });
    expect(noReason.ok).toBe(false);
    const closed = await c.shifts.close(companyId, { userId: person.id, supervisor: false }, shiftId, { declared: counted(5450), reason: 'gave wrong change' });
    expect(closed).toMatchObject({ ok: true, variance: -50 });
    const z = closed.ok ? closed.zNumber : '';
    expect(z).toMatch(/^Z-/);
    const report = await c.shifts.report(companyId, shiftId);
    expect(report).toMatchObject({ status: 'closed', declaredCash: 5450, expectedCash: 5500, variance: -50, varianceReason: 'gave wrong change', zNumber: z, paidIn: 500, closedBy: 'closer' });
    expect(await c.shifts.close(companyId, { userId: person.id, supervisor: false }, shiftId, { declared: counted(5450), reason: 'again' })).toEqual({ ok: false, error: 'That shift is already closed.' });
    const entries = await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectId, shiftId));
    expect(entries.map((e) => e.action).sort()).toEqual(['shift.closed', 'shift.opened']);
    // The person who closed can open another shift now.
    expect(await c.shifts.openShiftOf(person.id)).toBeNull();
  });

  it('gives each Z report the next number with none missing, in order of closing', async () => {
    const numbers: string[] = [];
    for (let n = 0; n < 3; n += 1) {
      const t = await till();
      const person = await user('zed');
      const id = await open(person, t.id, 1000);
      const r = await c.shifts.close(companyId, { userId: person.id, supervisor: false }, id, { declared: counted(1000), reason: '' });
      if (!r.ok) throw new Error(r.error);
      numbers.push(r.zNumber);
    }
    const last = (z: string) => Number(z.slice(z.lastIndexOf('-') + 1));
    expect([last(numbers[1] ?? ''), last(numbers[2] ?? '')]).toEqual([last(numbers[0] ?? '') + 1, last(numbers[0] ?? '') + 2]);
  });

  it('lets only a supervisor close a shift that is out by more than the tolerance, or another person\'s shift', async () => {
    const t = await till();
    const person = await user('shorty');
    const boss = await user('boss');
    const shiftId = await open(person, t.id, 5000);
    const refused = await c.shifts.close(companyId, { userId: person.id, supervisor: false }, shiftId, { declared: counted(4000), reason: 'short' });
    expect(refused).toEqual({ ok: false, error: 'The difference is more than the company allows a till to be out by. A supervisor has to close this shift.' });
    expect(await c.shifts.close(companyId, { userId: boss.id, supervisor: false }, shiftId, { declared: counted(5000), reason: '' })).toEqual({ ok: false, error: 'This is another person\'s shift: only a supervisor can close it.' });
    const done = await c.shifts.close(companyId, { userId: boss.id, supervisor: true }, shiftId, { declared: counted(4000), reason: 'cashier short, counted twice' });
    expect(done).toMatchObject({ ok: true, variance: -1000 });
    expect((await c.shifts.report(companyId, shiftId))?.closedBy).toBe('boss');
  });

  it('follows the company\'s tolerance, which is changed with a reason and recorded', async () => {
    expect(await c.shifts.tolerance(companyId)).toEqual({ amount: 100, percent: 1 });
    await c.shifts.saveTolerance(companyId, actor, { amount: 0, percent: 0 }, reason);
    try {
      const t = await till();
      const person = await user('strict');
      const shiftId = await open(person, t.id, 5000);
      expect((await c.shifts.close(companyId, { userId: person.id, supervisor: false }, shiftId, { declared: counted(4995), reason: 'a few coins' })).ok).toBe(false);
      expect((await c.shifts.close(companyId, { userId: person.id, supervisor: false }, shiftId, { declared: counted(5000), reason: '' })).ok).toBe(true);
    } finally {
      await c.shifts.saveTolerance(companyId, actor, { amount: 100, percent: 1 }, reason);
    }
    await expect(c.shifts.saveTolerance(companyId, actor, { amount: -5, percent: 1 }, reason)).rejects.toThrow('allowed difference');
    const entries = await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectType, 'shift_settings'));
    expect(entries.length).toBeGreaterThanOrEqual(2);
  });

  it('never changes a closed shift: the database refuses an edit, a delete, or cash put into it', async () => {
    const t = await till();
    const person = await user('sealed');
    const shiftId = await open(person, t.id, 1000);
    await c.shifts.close(companyId, { userId: person.id, supervisor: false }, shiftId, { declared: counted(1000), reason: '' });
    await expect(db.update(schema.shifts).set({ declaredCash: '1' }).where(eq(schema.shifts.id, shiftId))).rejects.toThrow();
    await expect(db.delete(schema.shifts).where(eq(schema.shifts.id, shiftId))).rejects.toThrow();
    await expect(db.insert(schema.shiftMovements).values({ shiftId, kind: 'paid_in', amount: '10', reason: 'late', createdBy: 'x' })).rejects.toThrow();
    expect(await c.shifts.move(companyId, { userId: person.id, supervisor: false }, shiftId, { kind: 'paid_in', amount: 10, reason: 'too late' })).toEqual({ ok: false, error: 'That shift is closed.' });
    await expect(db.execute(sql`update shift_movements set amount = 1`)).rejects.toThrow();
  });

  it('lists shifts newest first in pages, and only a person\'s own when asked', async () => {
    const person = await user('lister');
    for (let n = 0; n < 3; n += 1) {
      const t = await till();
      const id = await open(person, t.id, 100);
      await c.shifts.close(companyId, { userId: person.id, supervisor: false }, id, { declared: counted(100), reason: '' });
    }
    const mine = await c.shifts.history(companyId, { onlyUser: person.id });
    expect(mine.rows).toHaveLength(3);
    expect(mine.rows.every((r) => r.openedBy === 'lister' && r.status === 'closed' && r.zNumber !== null)).toBe(true);
    expect(mine.rows.map((r) => r.openedAt)).toEqual([...mine.rows.map((r) => r.openedAt)].sort().reverse());
    const all = await c.shifts.history(companyId, {});
    expect(all.rows.length).toBeGreaterThanOrEqual(3);
    if (all.nextCursor !== null) expect((await c.shifts.history(companyId, { cursor: all.nextCursor })).rows.length).toBeGreaterThan(0);
  });
});
