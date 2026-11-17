import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { getContainer } from '@/server/di/container';
import type { drizzleDb } from '@/server/db/drizzle/client';
import type * as schemaModule from '@/server/db/drizzle/schema';
import type * as afterCommitModule from '@/server/kernel/after-commit';
import { parseCount } from './shift-rules';

/**
 * A close beyond the allowance, with the company's choice between a supervisor closing on the spot and the approval queue deciding
 * (database). Both ways must work, and switching between them must lock nobody out.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (url !== undefined && url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === undefined || url === '')('closing a till shift: supervisor or approval (database)', () => {
  let c: ReturnType<typeof getContainer>;
  let db: typeof drizzleDb;
  let schema: typeof schemaModule;
  let afterCommit: typeof afterCommitModule;
  let companyId: string;
  let branchId: string;
  const actor = { type: 'user' as const, id: 'shift-approval-test' };
  const reason = { code: 'POLICY_CHANGE' };
  const tolerance = { amount: 100, percent: 1 };

  const user = async (name: string) => {
    const [row] = await db.insert(schema.users).values({ email: `${name}-${randomUUID().slice(0, 8)}@sa.test`, passwordHash: 'x', name, role: 'manager' }).returning();
    if (row === undefined) throw new Error('no user');
    return row;
  };
  const counted = (total: number) => {
    const r = parseCount({ total }, 'cash');
    if (!r.ok) throw new Error(r.error);
    return r;
  };
  const openShift = async (person: { id: string }, float = 5000) => {
    const name = `Till ${randomUUID().slice(0, 6)}`;
    await c.shifts.saveRegister(companyId, actor, { branchId, name, isActive: true }, reason);
    const till = (await c.shifts.registerList(companyId)).find((r) => r.name === name);
    const opened = await c.shifts.open(companyId, { userId: person.id, branchId: null }, { registerId: till?.id ?? '', float: counted(float) });
    if (!opened.ok) throw new Error(opened.error);
    return opened.shiftId;
  };
  const mode = async (supervisorClose: 'direct' | 'approval') => await c.shifts.saveSettings(companyId, actor, { tolerance, supervisorClose }, reason);
  /** Every close this requester asks for waits for this approver (other people's closes are not covered, so cases do not touch each other). */
  const workflowFor = async (approver: string, requester: string) => {
    const wf = await c.approvalConfig.createWorkflow(companyId, { code: `SHC-${randomUUID().slice(0, 8)}`, name: 'Till closes', trigger: 'shift.close_requested' }, actor);
    await c.approvalConfig.saveDraft(companyId, wf.id, { conditions: { op: 'and', children: [{ op: 'eq', field: 'requestedBy', value: requester }] }, steps: [{ sequence: 1, name: 'Approver', approver: { type: 'user', userId: approver } }] } as never, actor);
    await c.approvalConfig.publish(companyId, wf.id, actor, reason);
    return wf.id;
  };
  const entryOf = async (shiftId: string, approver: string) => {
    const entry = (await c.approvals.forDocument(companyId, 'shift_close', shiftId)).flatMap((r) => r.entries).find((e) => e.approverUserId === approver);
    if (entry === undefined) throw new Error('no approval entry');
    return entry;
  };

  beforeAll(async () => {
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    afterCommit = await import('@/server/kernel/after-commit');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    const { branch } = await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Shift Approval Co');
    branchId = ((await c.branches.getDefault(companyId)) ?? branch).id;
  });

  it('defaults to a supervisor closing on the spot, and the choice is changed with a reason and recorded', async () => {
    expect((await c.shifts.settings(companyId)).supervisorClose).toBe('direct');
    await mode('approval');
    expect((await c.shifts.settings(companyId)).supervisorClose).toBe('approval');
    await mode('direct');
    const entries = await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectType, 'shift_settings'));
    expect(entries.some((e) => (e.outcome as { supervisorClose?: string }).supervisorClose === 'approval')).toBe(true);
    await expect(db.execute(sql`update shift_settings set supervisor_close = 'sometimes'`)).rejects.toThrow();
  });

  it('in direct mode a supervisor closes a shift beyond the allowance and nothing is queued', async () => {
    await mode('direct');
    const cashier = await user('d-cashier');
    const boss = await user('d-boss');
    const shiftId = await openShift(cashier);
    expect(await c.shifts.close(companyId, { userId: cashier.id, supervisor: false }, shiftId, { declared: counted(4000), reason: 'short' })).toMatchObject({ ok: false });
    const done = await c.shifts.close(companyId, { userId: boss.id, supervisor: true }, shiftId, { declared: counted(4000), reason: 'cashier short, counted twice' });
    expect(done).toMatchObject({ ok: true, pending: false, variance: -1000 });
    expect(await c.approvals.forDocument(companyId, 'shift_close', shiftId)).toEqual([]);
  });

  it('in approval mode with no workflow covering it, a close beyond the allowance is refused in words and the shift stays open', async () => {
    await mode('approval');
    try {
      const cashier = await user('n-cashier');
      const shiftId = await openShift(cashier);
      const r = await c.shifts.close(companyId, { userId: cashier.id, supervisor: false }, shiftId, { declared: counted(4000), reason: 'short' });
      expect(r.ok).toBe(false);
      expect(r.ok ? '' : r.error).toContain('no approval workflow covers it');
      expect(await c.shifts.report(companyId, shiftId)).toMatchObject({ status: 'open', closeRequest: null });
      expect(await db.select().from(schema.shiftCloseRequests).where(eq(schema.shiftCloseRequests.shiftId, shiftId))).toEqual([]);
      // A close within the allowance never needs the queue.
      expect(await c.shifts.close(companyId, { userId: cashier.id, supervisor: false }, shiftId, { declared: counted(4950), reason: 'small change error' })).toMatchObject({ ok: true, pending: false });
    } finally {
      await mode('direct');
    }
  });

  it('in approval mode holds the shift, freezes its cash, and closes it from the same count once approved', async () => {
    await mode('approval');
    try {
      const cashier = await user('a-cashier');
      const approver = await user('a-approver');
      await workflowFor(approver.id, cashier.id);
      const shiftId = await openShift(cashier);
      const asked = await c.shifts.close(companyId, { userId: cashier.id, supervisor: false }, shiftId, { declared: counted(4000), reason: 'cashier short, counted twice' });
      expect(asked).toEqual({ ok: true, pending: true, variance: -1000 });
      const held = await c.shifts.report(companyId, shiftId);
      expect(held).toMatchObject({ status: 'closing', zNumber: null, closeRequest: { declaredCash: 4000, variance: -1000, reason: 'cashier short, counted twice' } });
      // Nothing moves while it waits, the till stays taken, and a second close is refused.
      expect(await c.shifts.move(companyId, { userId: cashier.id, supervisor: false }, shiftId, { kind: 'paid_in', amount: 10, reason: 'sneaky' })).toMatchObject({ ok: false });
      expect(await c.shifts.close(companyId, { userId: cashier.id, supervisor: false }, shiftId, { declared: counted(5000), reason: '' })).toEqual({ ok: false, error: 'This shift\'s close is waiting for approval.' });
      expect(await c.shifts.openShiftOf(cashier.id)).toBe(shiftId);
      expect((await c.shifts.registerList(companyId)).find((r) => r.openBy === 'a-cashier')).toBeDefined();
      expect((await c.shifts.history(companyId, { onlyUser: cashier.id })).rows[0]).toMatchObject({ status: 'closing', zNumber: null });
      const entry = await entryOf(shiftId, approver.id);
      await afterCommit.withAfterCommit(db, (t) => c.approvals.approve(entry.id, approver.id, null, t));
      const closed = await c.shifts.report(companyId, shiftId);
      expect(closed).toMatchObject({ status: 'closed', declaredCash: 4000, expectedCash: 5000, variance: -1000, varianceReason: 'cashier short, counted twice', closedBy: 'a-cashier', closeRequest: null });
      expect(closed?.zNumber).toMatch(/^Z-/);
      const [request] = await db.select().from(schema.shiftCloseRequests).where(eq(schema.shiftCloseRequests.shiftId, shiftId));
      expect(request?.status).toBe('approved');
      expect(await c.shifts.openShiftOf(cashier.id)).toBeNull();
      await expect(db.update(schema.shiftCloseRequests).set({ status: 'rejected' }).where(eq(schema.shiftCloseRequests.shiftId, shiftId))).rejects.toThrow();
      await expect(db.delete(schema.shiftCloseRequests).where(eq(schema.shiftCloseRequests.shiftId, shiftId))).rejects.toThrow();
    } finally {
      await mode('direct');
    }
  });

  it('a rejection reopens the shift for a recount, with what the approver said kept, and a recount can be asked for again', async () => {
    await mode('approval');
    try {
      const cashier = await user('r-cashier');
      const approver = await user('r-approver');
      await workflowFor(approver.id, cashier.id);
      const shiftId = await openShift(cashier);
      await c.shifts.close(companyId, { userId: cashier.id, supervisor: false }, shiftId, { declared: counted(3000), reason: 'counted in a hurry' });
      const entry = await entryOf(shiftId, approver.id);
      await afterCommit.withAfterCommit(db, (t) => c.approvals.reject(entry.id, approver.id, { reasonCode: 'POLICY_CHANGE', comment: 'recount please' }, t));
      expect(await c.shifts.report(companyId, shiftId)).toMatchObject({ status: 'open', closeRequest: null });
      const [first] = await db.select().from(schema.shiftCloseRequests).where(eq(schema.shiftCloseRequests.shiftId, shiftId));
      expect(first).toMatchObject({ status: 'rejected' });
      expect(first?.decisionNote).toContain('recount please');
      // Cash can move again, and a recount within the allowance closes without the queue.
      expect(await c.shifts.move(companyId, { userId: cashier.id, supervisor: false }, shiftId, { kind: 'paid_in', amount: 10, reason: 'found in a drawer' })).toEqual({ ok: true });
      expect(await c.shifts.close(companyId, { userId: cashier.id, supervisor: false }, shiftId, { declared: counted(5010), reason: '' })).toMatchObject({ ok: true, pending: false, variance: 0 });
    } finally {
      await mode('direct');
    }
  });

  it('lets the requester withdraw a waiting close, and it can be asked for again', async () => {
    await mode('approval');
    try {
      const cashier = await user('w-cashier');
      const other = await user('w-other');
      const approver = await user('w-approver');
      await workflowFor(approver.id, cashier.id);
      const shiftId = await openShift(cashier);
      await c.shifts.close(companyId, { userId: cashier.id, supervisor: false }, shiftId, { declared: counted(3000), reason: 'counted in a hurry' });
      expect(await c.shifts.withdrawClose(companyId, { userId: other.id, supervisor: false }, shiftId)).toMatchObject({ ok: false });
      expect(await c.shifts.withdrawClose(companyId, { userId: cashier.id, supervisor: false }, shiftId)).toEqual({ ok: true });
      expect(await c.shifts.report(companyId, shiftId)).toMatchObject({ status: 'open' });
      const [request] = await db.select().from(schema.shiftCloseRequests).where(eq(schema.shiftCloseRequests.shiftId, shiftId));
      expect(request?.status).toBe('canceled');
      expect(await c.shifts.withdrawClose(companyId, { userId: cashier.id, supervisor: false }, shiftId)).toMatchObject({ ok: false });
      expect(await c.shifts.close(companyId, { userId: cashier.id, supervisor: false }, shiftId, { declared: counted(3000), reason: 'counted again, still short' })).toEqual({ ok: true, pending: true, variance: -2000 });
    } finally {
      await mode('direct');
    }
  });

  it('in approval mode a supervisor still closes another person\'s shift on the spot, but their own goes to the queue', async () => {
    await mode('approval');
    try {
      const cashier = await user('s-cashier');
      const boss = await user('s-boss');
      const approver = await user('s-approver');
      await workflowFor(approver.id, boss.id);
      const theirs = await openShift(cashier);
      expect(await c.shifts.close(companyId, { userId: boss.id, supervisor: true }, theirs, { declared: counted(4000), reason: 'cashier left, counted for them' })).toMatchObject({ ok: true, pending: false });
      const mine = await openShift(boss);
      expect(await c.shifts.close(companyId, { userId: boss.id, supervisor: true }, mine, { declared: counted(4000), reason: 'my own till is short' })).toEqual({ ok: true, pending: true, variance: -1000 });
    } finally {
      await mode('direct');
    }
  });

  it('switching back to a supervisor closing locks nobody out: a close that was already waiting is still decided by the queue', async () => {
    await mode('approval');
    const cashier = await user('x-cashier');
    const approver = await user('x-approver');
    await workflowFor(approver.id, cashier.id);
    const shiftId = await openShift(cashier);
    await c.shifts.close(companyId, { userId: cashier.id, supervisor: false }, shiftId, { declared: counted(3000), reason: 'counted in a hurry' });
    await mode('direct');
    expect(await c.shifts.report(companyId, shiftId)).toMatchObject({ status: 'closing' });
    const entry = await entryOf(shiftId, approver.id);
    await afterCommit.withAfterCommit(db, (t) => c.approvals.approve(entry.id, approver.id, null, t));
    expect(await c.shifts.report(companyId, shiftId)).toMatchObject({ status: 'closed', variance: -2000 });
  });
});
