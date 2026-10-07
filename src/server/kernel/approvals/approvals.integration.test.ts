import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

/**
 * The approval engine against a real database:  TEST_DATABASE_URL=postgres://... pnpm test
 * Each test scopes its workflows to its own customer id, so tests do not see each other's rules.
 */
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;

describe.skipIf(!url)('approvals (database)', () => {
  type Container = ReturnType<typeof import('@/server/di/container').getContainer>;
  let c: Container;
  let db: typeof import('@/server/db/drizzle/client').drizzleDb;
  let schema: typeof import('@/server/db/drizzle/schema');
  let companyId: string;
  let ApprovalError: typeof import('./engine').ApprovalError;
  let ApprovalConfigError: typeof import('./config-service').ApprovalConfigError;

  const actor = { type: 'user' as const, id: 'admin-test' };
  const reason = { code: 'POLICY_CHANGE' };
  const released: string[] = [];
  const rejected: string[] = [];
  const reopened: string[] = [];
  /** What each fake document looks like "now", for change detection. */
  const live = new Map<string, Record<string, unknown>>();

  const user = async (label: string) => {
    const [u] = await db
      .insert(schema.users)
      .values({
        email: `${label}-${randomUUID()}@approvals.test`,
        passwordHash: 'x',
        name: label,
        role: 'manager',
      })
      .returning();
    return u!.id;
  };
  const tx = <T>(fn: (t: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>) =>
    db.transaction(fn);
  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'OK';
    } catch (e) {
      return e instanceof ApprovalError || e instanceof ApprovalConfigError
        ? e.code
        : `OTHER:${(e as Error).message}`;
    }
  };

  /** clerk -> sup (50k) -> mgr (500k) -> fin (unlimited) */
  async function people() {
    const [clerk, sup, mgr, fin] = await Promise.all(['clerk', 'sup', 'mgr', 'fin'].map(user));
    const limit = (n: number | null) => [
      { documentKind: 'sales_order', maxAmount: n, unlimited: n === null },
    ];
    await c.approvalConfig.saveProfile(
      companyId,
      { userId: fin!, limits: limit(null) },
      actor,
      reason,
    );
    await c.approvalConfig.saveProfile(
      companyId,
      { userId: mgr!, approverUserId: fin, limits: limit(500_000) },
      actor,
      reason,
    );
    await c.approvalConfig.saveProfile(
      companyId,
      { userId: sup!, approverUserId: mgr, limits: limit(50_000) },
      actor,
      reason,
    );
    await c.approvalConfig.saveProfile(
      companyId,
      { userId: clerk!, approverUserId: sup, limits: [] },
      actor,
      reason,
    );
    return { clerk: clerk!, sup: sup!, mgr: mgr!, fin: fin! };
  }

  async function workflow(scope: string, steps: unknown[], extra: { code?: string } = {}) {
    const wf = await c.approvalConfig.createWorkflow(
      companyId,
      {
        code: extra.code ?? `T-${randomUUID().slice(0, 8)}`,
        name: 'Test workflow',
        trigger: 'sales_order.submitted',
      },
      actor,
    );
    await c.approvalConfig.saveDraft(
      companyId,
      wf.id,
      { conditions: { op: 'eq', field: 'customer.id', value: scope }, steps } as never,
      actor,
    );
    await c.approvalConfig.publish(companyId, wf.id, actor, reason);
    return wf;
  }

  const step = (sequence: number, approver: unknown, over: Record<string, unknown> = {}) => ({
    sequence,
    name: `Step ${sequence}`,
    approver,
    ...over,
  });

  const submit = (
    scope: string,
    requestedBy: string,
    amount: number,
    documentId = `doc-${randomUUID()}`,
  ) => {
    live.set(documentId, { customer: { id: scope }, total: amount });
    return {
      documentId,
      run: () =>
        tx((t) =>
          c.approvals.submit(
            {
              companyId,
              trigger: 'sales_order.submitted',
              documentId,
              requestedBy,
              amount,
              snapshot: { customer: { id: scope }, total: amount },
            },
            t,
          ),
        ),
    };
  };
  const approve = (entryId: string, by: string, comment: string | null = null) =>
    tx((t) => c.approvals.approve(entryId, by, comment, t));
  const openEntries = async (documentId: string) =>
    (await c.approvals.forDocument(companyId, 'sales_order', documentId))
      .flatMap((r) => r.entries)
      .filter((e) => e.status === 'open');

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    ({ ApprovalError } = await import('./engine'));
    ({ ApprovalConfigError } = await import('./config-service'));
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    c.approvals.registerDocument('sales_order', {
      snapshot: async (id) => live.get(id) ?? {},
      onReleased: async (id) => void released.push(id),
      onRejected: async (id) => void rejected.push(id),
      onReopened: async (id) => void reopened.push(id),
    });
  });

  it('lets a document proceed when no workflow matches, and records why', async () => {
    const s = submit('nobody', await user('r'), 1);
    expect(await s.run()).toEqual({ required: false, reason: 'no_matching_workflow' });
    const timeline = await c.decisionLog.timeline('sales_order', s.documentId);
    expect(timeline.map((t) => t.action)).toContain('approvals.not_required');
  });

  it('climbs the approver chain one lazy entry at a time, then releases once', async () => {
    const p = await people();
    const scope = randomUUID();
    await workflow(scope, [step(1, { type: 'chain_by_limit' })]);
    const s = submit(scope, p.clerk, 120_000);
    const result = await s.run();
    expect(result).toMatchObject({ required: true, released: false });

    // Only the first approver has an entry; the next is created when they approve.
    let open = await openEntries(s.documentId);
    expect(open.map((e) => e.approverUserId)).toEqual([p.sup]);
    expect(
      (await c.approvals.forDocument(companyId, 'sales_order', s.documentId))[0]!.entries,
    ).toHaveLength(1);

    expect((await approve(open[0]!.id, p.sup)).outcome).toBe('approved');
    open = await openEntries(s.documentId);
    expect(open.map((e) => e.approverUserId)).toEqual([p.mgr]);
    expect(released).not.toContain(s.documentId);

    const last = await approve(open[0]!.id, p.mgr, 'fine');
    expect(last).toMatchObject({ outcome: 'approved', requestStatus: 'approved', released: true });
    expect(released.filter((d) => d === s.documentId)).toHaveLength(1);
    expect(await openEntries(s.documentId)).toHaveLength(0);
  });

  it('only the assigned approver may act, and only once, even when two act at the same time', async () => {
    const p = await people();
    const scope = randomUUID();
    await workflow(scope, [step(1, { type: 'user', userId: p.mgr })]);
    const s = submit(scope, p.clerk, 10);
    await s.run();
    const [entry] = await openEntries(s.documentId);
    expect(await codeOf(approve(entry!.id, p.sup))).toBe('NOT_APPROVER');
    const results = await Promise.all([
      codeOf(approve(entry!.id, p.mgr)),
      codeOf(approve(entry!.id, p.mgr)),
    ]);
    expect(results.sort()).toEqual(['ALREADY_DECIDED', 'OK']);
    expect(released.filter((d) => d === s.documentId)).toHaveLength(1);
  });

  it('a requester cannot approve their own request', async () => {
    const p = await people();
    const scope = randomUUID();
    await workflow(scope, [step(1, { type: 'user', userId: p.mgr })]);
    expect(await codeOf(submit(scope, p.mgr, 10).run())).toBe('NO_ELIGIBLE_APPROVER');
  });

  it('rejection needs a reason, blocks the document until reopened, then starts a fresh linked request', async () => {
    const p = await people();
    const scope = randomUUID();
    await workflow(scope, [step(1, { type: 'user', userId: p.mgr })]);
    const s = submit(scope, p.clerk, 10);
    await s.run();
    const [entry] = await openEntries(s.documentId);

    expect(
      await codeOf(
        tx((t) => c.approvals.reject(entry!.id, p.mgr, { reasonCode: 'OTHER', comment: '  ' }, t)),
      ),
    ).toBe('COMMENT_REQUIRED');
    expect(
      (
        await tx((t) =>
          c.approvals.reject(
            entry!.id,
            p.mgr,
            { reasonCode: 'OTHER', comment: 'Price too low' },
            t,
          ),
        )
      ).outcome,
    ).toBe('rejected');
    expect(rejected).toContain(s.documentId);

    // Cannot just submit again.
    expect(await codeOf(s.run())).toBe('REOPEN_REQUIRED');
    // Only the requester (or an admin) may reopen.
    expect(
      await codeOf(
        tx((t) =>
          c.approvals.reopen(
            'sales_order',
            s.documentId,
            { userId: p.sup },
            { text: 'x' },
            t,
            companyId,
          ),
        ),
      ),
    ).toBe('NOT_ALLOWED');
    await tx((t) =>
      c.approvals.reopen(
        'sales_order',
        s.documentId,
        { userId: p.clerk },
        { text: 'Fixed the price' },
        t,
        companyId,
      ),
    );
    expect(reopened).toContain(s.documentId);

    expect(await s.run()).toMatchObject({ required: true });
    const history = await c.approvals.forDocument(companyId, 'sales_order', s.documentId);
    expect(history.map((r) => r.status)).toEqual(['reopened', 'pending']);
    expect(history[1]).toMatchObject({ attempt: 2, previousRequestId: history[0]!.id });
    // Nothing carried over: the new request has only its own, fresh entry.
    expect(history[1]!.entries.map((e) => e.status)).toEqual(['open']);
  });

  it('when several workflows match, all apply; one rejection cancels the rest', async () => {
    const p = await people();
    const scope = randomUUID();
    await workflow(scope, [step(1, { type: 'user', userId: p.sup })]);
    await workflow(scope, [step(1, { type: 'user', userId: p.mgr })]);
    const s = submit(scope, p.clerk, 10);
    const result = await s.run();
    expect(result).toMatchObject({ required: true });
    expect((result as { requests: unknown[] }).requests).toHaveLength(2);

    const entries = await openEntries(s.documentId);
    expect(entries).toHaveLength(2);
    await approve(entries.find((e) => e.approverUserId === p.sup)!.id, p.sup);
    expect(released).not.toContain(s.documentId);
    await approve(entries.find((e) => e.approverUserId === p.mgr)!.id, p.mgr);
    expect(released).toContain(s.documentId);

    // And the rejection path.
    const s2 = submit(scope, p.clerk, 10);
    await s2.run();
    const e2 = await openEntries(s2.documentId);
    await tx((t) =>
      c.approvals.reject(
        e2.find((e) => e.approverUserId === p.sup)!.id,
        p.sup,
        { reasonCode: 'OTHER', comment: 'No' },
        t,
      ),
    );
    const statuses = (await c.approvals.forDocument(companyId, 'sales_order', s2.documentId))
      .map((r) => r.status)
      .sort();
    expect(statuses).toEqual(['canceled', 'rejected']);
    expect(await openEntries(s2.documentId)).toHaveLength(0);
  });

  it('skips a step whose condition says it does not apply, with a record', async () => {
    const p = await people();
    const scope = randomUUID();
    await workflow(scope, [
      step(1, { type: 'user', userId: p.sup }),
      step(
        2,
        { type: 'user', userId: p.mgr },
        { skipIf: { op: 'lt', field: 'amount', value: 100_000 } },
      ),
    ]);
    const s = submit(scope, p.clerk, 5_000);
    await s.run();
    const [e] = await openEntries(s.documentId);
    expect(await approve(e!.id, p.sup)).toMatchObject({
      requestStatus: 'approved',
      released: true,
    });
    const [request] = await c.approvals.forDocument(companyId, 'sales_order', s.documentId);
    const log = await c.decisionLog.timeline('approval_request', request!.id);
    expect(log.map((l) => l.action)).toContain('approvals.step_skipped');
  });

  it('"any one" group: first to act wins and the others are withdrawn', async () => {
    const p = await people();
    const scope = randomUUID();
    const g = await c.approvalConfig.saveGroup(
      companyId,
      { code: `G-${randomUUID().slice(0, 6)}`, name: 'Any', memberUserIds: [p.sup, p.mgr] },
      actor,
      reason,
    );
    await workflow(scope, [step(1, { type: 'group', groupId: g.id, require: 'any_one' })]);
    const s = submit(scope, p.clerk, 1);
    await s.run();
    const entries = await openEntries(s.documentId);
    expect(entries).toHaveLength(2);
    await approve(entries[0]!.id, entries[0]!.approverUserId);
    const all = (await c.approvals.forDocument(companyId, 'sales_order', s.documentId))[0]!.entries;
    expect(all.map((e) => e.status).sort()).toEqual(['approved', 'canceled']);
    expect(released).toContain(s.documentId);
  });

  it('"all" group follows the member order, which can be changed at runtime', async () => {
    const p = await people();
    const scope = randomUUID();
    const g = await c.approvalConfig.saveGroup(
      companyId,
      { code: `G-${randomUUID().slice(0, 6)}`, name: 'All', memberUserIds: [p.sup, p.mgr] },
      actor,
      reason,
    );
    await workflow(scope, [step(1, { type: 'group', groupId: g.id, require: 'all' })]);
    // Reorder before anyone has been asked: the new order applies.
    await c.approvalConfig.saveGroup(
      companyId,
      {
        id: g.id,
        code: `O-${randomUUID().slice(0, 6)}`,
        name: 'All',
        memberUserIds: [p.mgr, p.sup],
      },
      actor,
      reason,
    );
    const s = submit(scope, p.clerk, 1);
    await s.run();
    expect((await openEntries(s.documentId)).map((e) => e.approverUserId)).toEqual([p.mgr]);
  });

  it('a substitute covers for an absent approver, and the entry says on whose behalf', async () => {
    const p = await people();
    const cover = await user('cover');
    await c.approvalConfig.saveProfile(companyId, { userId: cover, limits: [] }, actor, reason);
    await c.approvalConfig.saveProfile(
      companyId,
      {
        userId: p.sup,
        approverUserId: p.mgr,
        substituteUserId: cover,
        substituteFrom: '2000-01-01',
        substituteTo: '2999-12-31',
        limits: [{ documentKind: 'sales_order', maxAmount: 50_000 }],
      },
      actor,
      reason,
    );
    const scope = randomUUID();
    await workflow(scope, [step(1, { type: 'user', userId: p.sup })]);
    const s = submit(scope, p.clerk, 1);
    await s.run();
    const [e] = await openEntries(s.documentId);
    expect(e).toMatchObject({ approverUserId: cover, onBehalfOfUserId: p.sup });
    expect(await codeOf(approve(e!.id, p.sup))).toBe('NOT_APPROVER');
    expect((await approve(e!.id, cover)).outcome).toBe('approved');
  });

  it('voids approvals when the document changes after submission', async () => {
    const p = await people();
    const scope = randomUUID();
    await workflow(scope, [step(1, { type: 'user', userId: p.sup })]);
    const s = submit(scope, p.clerk, 100);
    await s.run();
    const [e] = await openEntries(s.documentId);
    live.set(s.documentId, { customer: { id: scope }, total: 999 }); // edited meanwhile
    const result = await approve(e!.id, p.sup);
    expect(result.outcome).toBe('superseded');
    expect(released).not.toContain(s.documentId);
    expect((await c.approvals.forDocument(companyId, 'sales_order', s.documentId))[0]!.status).toBe(
      'superseded',
    );
    // A fresh submission is allowed.
    live.set(s.documentId, { customer: { id: scope }, total: 999 });
    expect(await codeOf(s.run())).toBe('OK');
  });

  it('in-flight requests keep their workflow version when the workflow is edited', async () => {
    const p = await people();
    const scope = randomUUID();
    const wf = await workflow(scope, [
      step(1, { type: 'user', userId: p.sup }),
      step(2, { type: 'user', userId: p.mgr }),
    ]);
    const s = submit(scope, p.clerk, 1);
    await s.run();
    // v2 drops step 2.
    await c.approvalConfig.saveDraft(
      companyId,
      wf.id,
      {
        conditions: { op: 'eq', field: 'customer.id', value: scope },
        steps: [step(1, { type: 'user', userId: p.sup })],
      } as never,
      actor,
    );
    await c.approvalConfig.publish(companyId, wf.id, actor, reason);
    const [e] = await openEntries(s.documentId);
    expect(await approve(e!.id, p.sup)).toMatchObject({ requestStatus: 'pending' }); // still asks step 2 (v1)
    expect((await openEntries(s.documentId)).map((x) => x.approverUserId)).toEqual([p.mgr]);
    // A new document uses v2: one step.
    const s2 = submit(scope, p.clerk, 1);
    await s2.run();
    const [e2] = await openEntries(s2.documentId);
    expect(await approve(e2!.id, p.sup)).toMatchObject({ requestStatus: 'approved' });
  });

  it('a switch turns approvals off per module, and a branch-level switch is more specific', async () => {
    const p = await people();
    const scope = randomUUID();
    await workflow(scope, [step(1, { type: 'user', userId: p.sup })]);
    await c.approvalConfig.setSwitch(companyId, { module: 'sales', enabled: false }, actor, reason);
    try {
      expect(await submit(scope, p.clerk, 1).run()).toEqual({
        required: false,
        reason: 'module_disabled',
      });
      await c.approvalConfig.setSwitch(
        companyId,
        { module: 'sales', trigger: 'sales_order.submitted', enabled: true },
        actor,
        reason,
      );
      expect(await submit(scope, p.clerk, 1).run()).toMatchObject({ required: true });
    } finally {
      await db
        .delete(schema.approvalSwitches)
        .where(eq(schema.approvalSwitches.companyId, companyId));
    }
  });

  it('refuses to publish a workflow that could get stuck', async () => {
    const p = await people();
    const emptyGroup = await c.approvalConfig.saveGroup(
      companyId,
      { code: `E-${randomUUID().slice(0, 6)}`, name: 'Empty', memberUserIds: [] },
      actor,
      reason,
    );
    const wf = await c.approvalConfig.createWorkflow(
      companyId,
      { code: `B-${randomUUID().slice(0, 6)}`, name: 'Bad', trigger: 'sales_order.submitted' },
      actor,
    );
    await c.approvalConfig.saveDraft(
      companyId,
      wf.id,
      {
        steps: [
          step(1, { type: 'group', groupId: emptyGroup.id, require: 'all' }),
          step(1, { type: 'user', userId: randomUUID() }),
        ],
      } as never,
      actor,
    );
    let error: unknown;
    try {
      await c.approvalConfig.publish(companyId, wf.id, actor, reason);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ApprovalConfigError);
    const messages = (error as InstanceType<typeof ApprovalConfigError>).issues
      .map((i) => i.message)
      .join(' | ');
    expect(messages).toMatch(/no members/);
    expect(messages).toMatch(/does not exist/);
    expect(messages).toMatch(/share the order/);
    void p;
  });

  it('refuses an approval chain that loops back, and a change with no reason', async () => {
    const [a, b] = await Promise.all([user('a'), user('b')]);
    await c.approvalConfig.saveProfile(
      companyId,
      { userId: a, approverUserId: b, limits: [] },
      actor,
      reason,
    );
    expect(
      await codeOf(
        c.approvalConfig.saveProfile(
          companyId,
          { userId: b, approverUserId: a, limits: [] },
          actor,
          reason,
        ),
      ),
    ).toBe('INVALID_PROFILE');
    expect(
      await codeOf(c.approvalConfig.saveProfile(companyId, { userId: b, limits: [] }, actor, {})),
    ).toMatch(/REASON_REQUIRED|OTHER/);
  });
  // ── A-3: overdue escalation, reroute, "n of" groups, role approvers ──

  const later = (hours: number) => new Date(Date.now() + hours * 3_600_000);
  const entriesOf = async (documentId: string) =>
    (await c.approvals.forDocument(companyId, 'sales_order', documentId)).flatMap((r) => r.entries);

  it('escalates an overdue entry to the approver’s own approver, once, and the chain carries on from there', async () => {
    const p = await people();
    const scope = randomUUID();
    await workflow(scope, [step(1, { type: 'chain_by_limit' }, { dueAfterHours: 1 })]);
    const s = submit(scope, p.clerk, 10);
    await s.run();
    expect((await openEntries(s.documentId))[0]!.dueAt).not.toBeNull();

    // Not due yet: nothing happens to this document.
    await c.approvals.sweepOverdue({ now: new Date() });
    expect((await openEntries(s.documentId)).map((e) => e.approverUserId)).toEqual([p.sup]);

    // Two workers sweeping at the same moment still escalate it only once.
    const at = later(2);
    await Promise.all([
      c.approvals.sweepOverdue({ now: at }),
      c.approvals.sweepOverdue({ now: at }),
    ]);
    const all = await entriesOf(s.documentId);
    expect(all.map((e) => e.status).sort()).toEqual(['canceled', 'open']);
    const open = (await openEntries(s.documentId))[0]!;
    expect(open.approverUserId).toBe(p.mgr);
    expect(open.replacesEntryId).toBe(all.find((e) => e.status === 'canceled')!.id);
    expect(open.dueAt!.getTime()).toBeGreaterThan(at.getTime()); // it can escalate again later

    const log = await c.decisionLog.timeline(
      'approval_request',
      (await c.approvals.forDocument(companyId, 'sales_order', s.documentId))[0]!.id,
    );
    expect(log.filter((l) => l.action === 'approvals.escalated')).toHaveLength(1);

    // The manager covers 10 shillings, so approving finishes the chain.
    expect(await approve(open.id, p.mgr)).toMatchObject({
      requestStatus: 'approved',
      released: true,
    });
  });

  it('notes once when nobody is above the approver, leaving the entry open for an administrator', async () => {
    const p = await people();
    const scope = randomUUID();
    await workflow(scope, [step(1, { type: 'user', userId: p.fin }, { dueAfterHours: 1 })]);
    const s = submit(scope, p.clerk, 10);
    await s.run();
    const at = later(2);
    const first = await c.approvals.sweepOverdue({ now: at });
    expect(first.stuck).toBeGreaterThanOrEqual(1);
    expect((await openEntries(s.documentId)).map((e) => e.approverUserId)).toEqual([p.fin]);
    await c.approvals.sweepOverdue({ now: at });
    const requestId = (await c.approvals.forDocument(companyId, 'sales_order', s.documentId))[0]!
      .id;
    const log = await c.decisionLog.timeline('approval_request', requestId);
    expect(log.filter((l) => l.action === 'approvals.escalation_failed')).toHaveLength(1);
  });

  it('an administrator can reroute an open entry, with a reason, and the old one is closed', async () => {
    const p = await people();
    const scope = randomUUID();
    await workflow(scope, [step(1, { type: 'user', userId: p.sup })]);
    const s = submit(scope, p.clerk, 10);
    await s.run();
    const [entry] = await openEntries(s.documentId);
    const suspended = await user('gone');
    await db
      .update(schema.users)
      .set({ status: 'suspended' })
      .where(eq(schema.users.id, suspended));

    const reroute = (to: string, code = 'POLICY_CHANGE') =>
      tx((t) =>
        c.approvals.reroute(entry!.id, to, { userId: p.fin }, { code, text: 'On leave' }, t),
      );
    expect(await codeOf(reroute(suspended))).toBe('NO_ELIGIBLE_APPROVER');
    expect(await codeOf(reroute(p.clerk))).toBe('NO_ELIGIBLE_APPROVER'); // the requester
    expect(await codeOf(reroute(p.fin, 'NOPE'))).toMatch(/Reason "NOPE" does not exist/);
    await reroute(p.fin);

    const all = await entriesOf(s.documentId);
    expect(all.find((e) => e.id === entry!.id)).toMatchObject({ status: 'canceled' });
    const now = (await openEntries(s.documentId))[0]!;
    expect(now).toMatchObject({ approverUserId: p.fin, replacesEntryId: entry!.id });
    expect(await codeOf(approve(entry!.id, p.sup))).toBe('ALREADY_DECIDED');
    expect((await approve(now.id, p.fin)).outcome).toBe('approved');
    expect(released).toContain(s.documentId);
  });

  it('"n of" group: needs that many approvals, then withdraws the rest', async () => {
    const p = await people();
    const scope = randomUUID();
    const g = await c.approvalConfig.saveGroup(
      companyId,
      {
        code: `N-${randomUUID().slice(0, 6)}`,
        name: 'Two of three',
        memberUserIds: [p.sup, p.mgr, p.fin],
      },
      actor,
      reason,
    );
    await workflow(scope, [step(1, { type: 'group', groupId: g.id, require: 'n_of', count: 2 })]);
    const s = submit(scope, p.clerk, 1);
    await s.run();
    const open = await openEntries(s.documentId);
    expect(open).toHaveLength(3);
    expect((await approve(open[0]!.id, open[0]!.approverUserId)).outcome).toBe('approved');
    expect(released).not.toContain(s.documentId);
    expect(await openEntries(s.documentId)).toHaveLength(2);
    expect(await approve(open[1]!.id, open[1]!.approverUserId)).toMatchObject({ released: true });
    expect((await entriesOf(s.documentId)).map((e) => e.status).sort()).toEqual([
      'approved',
      'approved',
      'canceled',
    ]);
  });

  it('refuses to publish an "n of" step that asks for more people than the group has', async () => {
    const p = await people();
    const g = await c.approvalConfig.saveGroup(
      companyId,
      { code: `N-${randomUUID().slice(0, 6)}`, name: 'Pair', memberUserIds: [p.sup, p.mgr] },
      actor,
      reason,
    );
    const wf = await c.approvalConfig.createWorkflow(
      companyId,
      { code: `N-${randomUUID().slice(0, 6)}`, name: 'Too many', trigger: 'sales_order.submitted' },
      actor,
    );
    await c.approvalConfig.saveDraft(
      companyId,
      wf.id,
      { steps: [step(1, { type: 'group', groupId: g.id, require: 'n_of', count: 3 })] } as never,
      actor,
    );
    expect(await codeOf(c.approvalConfig.publish(companyId, wf.id, actor, reason))).toBe(
      'INVALID_DEFINITION',
    );
    await c.approvalConfig.saveDraft(
      companyId,
      wf.id,
      { steps: [step(1, { type: 'group', groupId: g.id, require: 'n_of' })] } as never,
      actor,
    );
    expect(await codeOf(c.approvalConfig.publish(companyId, wf.id, actor, reason))).toBe(
      'INVALID_DEFINITION',
    );
  });

  it('role approver: everyone holding the role is asked, the first to act decides', async () => {
    const p = await people();
    const roleKey = `approvals-test-${randomUUID().slice(0, 8)}`;
    const [role] = await db
      .insert(schema.roles)
      .values({ key: roleKey, name: 'Test approvers' })
      .returning();
    for (const u of [p.sup, p.mgr])
      await db.insert(schema.userRoles).values({ userId: u, roleId: role!.id });
    const scope = randomUUID();
    await workflow(scope, [step(1, { type: 'role', roleKey })]);
    const s = submit(scope, p.clerk, 1);
    await s.run();
    const open = await openEntries(s.documentId);
    expect(open.map((e) => e.approverUserId).sort()).toEqual([p.sup, p.mgr].sort());
    await approve(open[0]!.id, open[0]!.approverUserId);
    expect((await entriesOf(s.documentId)).map((e) => e.status).sort()).toEqual([
      'approved',
      'canceled',
    ]);
    expect(released).toContain(s.documentId);

    // A role nobody holds, or that does not exist, cannot be published.
    for (const key of [`approvals-empty-${randomUUID().slice(0, 6)}`, 'no-such-role']) {
      if (key.startsWith('approvals-empty'))
        await db.insert(schema.roles).values({ key, name: 'Empty' });
      const wf = await c.approvalConfig.createWorkflow(
        companyId,
        { code: `R-${randomUUID().slice(0, 6)}`, name: 'Role', trigger: 'sales_order.submitted' },
        actor,
      );
      await c.approvalConfig.saveDraft(
        companyId,
        wf.id,
        { steps: [step(1, { type: 'role', roleKey: key })] } as never,
        actor,
      );
      expect(await codeOf(c.approvalConfig.publish(companyId, wf.id, actor, reason))).toBe(
        'INVALID_DEFINITION',
      );
    }
  });
});
