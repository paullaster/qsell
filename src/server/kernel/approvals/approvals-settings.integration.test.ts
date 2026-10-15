import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { drizzleDb as Db } from '@/server/db/drizzle/client';
import type * as Schema from '@/server/db/drizzle/schema';
import type * as Sources from '@/server/domains/lookups/sources';
import type * as Request from '@/server/domains/lookups/request';
import type { AppContainer } from '@/server/di/container';

/**
 * The approval settings against a real database: the pickers' lists (people, groups, roles,
 * branches, fields, comparisons, scopes), and the paged lists behind the Approvers, Workflows,
 * Switches and Monitor screens.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL ?? '';
if (url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === '')('approval settings (database)', () => {
  let db: typeof Db;
  let schema: typeof Schema;
  let sources: typeof Sources;
  let request: typeof Request;
  let c: AppContainer;
  let companyId = '';
  let boss = '';
  let clerk = '';
  let customerId = '';
  const tag = randomUUID().slice(0, 5).toUpperCase();
  const actor = { type: 'user' as const, id: 'tester' };
  const reason = { code: 'POLICY_CHANGE' };

  const search = async (key: string, over: { query?: string; filters?: Record<string, string> } = {}) => {
    const parsed = request.parseLookupRequest({ source: key, query: over.query, filters: over.filters });
    if (!parsed.ok) throw new Error(parsed.error);
    const source = sources.getLookupSource(key);
    if (source === undefined) throw new Error(`no source ${key}`);
    const { query, limit, after, filters } = parsed.value;
    return await source.search({ companyId, query, limit, after, filters });
  };
  const user = async (name: string, over: Record<string, unknown> = {}) =>
    (await db.insert(schema.users).values({ email: `${name}-${randomUUID()}@approvals-settings.test`, passwordHash: 'x', name, role: 'manager', ...over }).returning())[0]?.id ?? '';

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    sources = await import('@/server/domains/lookups/sources');
    request = await import('@/server/domains/lookups/request');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    boss = await user(`${tag} Boss`);
    clerk = await user(`${tag} Clerk`);
    await user(`${tag} Customer`, { role: 'customer' });
    await user(`${tag} Suspended`, { status: 'suspended' });
    customerId = randomUUID();
  });

  describe('the pickers', () => {
    it('offer staff who can approve: not customers, not suspended people, never the excluded one', async () => {
      const found = await search('approval-users', { query: tag });
      expect(found.options.map((o) => o.label).sort()).toEqual([`${tag} Boss`, `${tag} Clerk`]);
      expect(found.options[0]?.description).toMatch(/@approvals-settings\.test$/);
      const without = await search('approval-users', { query: tag, filters: { exclude: boss } });
      expect(without.options.map((o) => o.id)).toEqual([clerk]);
      await expect(search('approval-users', { filters: { exclude: 'nope' } })).rejects.toThrow();
    });

    it('offer groups with how many people are in them', async () => {
      await c.approvalConfig.saveGroup(companyId, { code: `${tag}G`, name: `${tag} Finance`, memberUserIds: [boss, clerk] }, actor, reason);
      const groups = await search('approval-groups', { query: tag });
      expect(groups.options).toHaveLength(1);
      expect(groups.options[0]?.description).toBe('2 people');
      expect(groups.options[0]?.meta).toEqual({ members: '2' });
    });

    it('offer roles that are active and never the customer role', async () => {
      const found = await search('approval-roles');
      expect(found.options.map((o) => o.id)).not.toContain('customer');
      expect(found.options.length).toBeGreaterThan(0);
    });

    it('offer active branches', async () => {
      await db.insert(schema.branches).values([{ companyId, code: `A${tag}`, name: `${tag} Open` }, { companyId, code: `B${tag}`, name: `${tag} Shut`, isActive: false }]);
      expect((await search('approval-branches', { query: tag })).options.map((o) => o.label)).toEqual([`${tag} Open`]);
    });

    it('offer the situations, the fields of one situation and the comparisons for a kind of field', async () => {
      const triggers = await search('approval-triggers');
      expect(triggers.options.map((o) => o.id)).toContain('sales_order.submitted');
      const fields = await search('approval-trigger-fields', { filters: { trigger: 'sales_order.submitted' } });
      expect(fields.options.map((o) => o.id)).toContain('amount');
      const numbers = await search('approval-trigger-fields', { filters: { trigger: 'sales_order.submitted', type: 'number', exclude: 'amount' } });
      expect(numbers.options.every((o) => o.meta?.type === 'number')).toBe(true);
      expect(numbers.options.map((o) => o.id)).not.toContain('amount');
      await expect(search('approval-trigger-fields')).rejects.toThrow();
      await expect(search('approval-trigger-fields', { filters: { trigger: 'nope' } })).rejects.toThrow();
      await expect(search('approval-trigger-fields', { filters: { trigger: 'sales_order.submitted', type: 'weird' } })).rejects.toThrow();
      expect((await search('approval-comparisons', { filters: { type: 'boolean' } })).options.map((o) => o.id)).toEqual(['eq', 'ne']);
      await expect(search('approval-comparisons')).rejects.toThrow();
    });

    it('offer the fixed lists and the switch scopes', async () => {
      expect((await search('approval-on-off')).options.map((o) => o.id).sort()).toEqual(['false', 'true']);
      expect((await search('approval-authority-modes')).options.map((o) => o.id).sort()).toEqual(['none', 'unlimited', 'up_to']);
      expect((await search('approval-rule-types')).options).toHaveLength(6);
      const scopes = await search('approval-switch-scopes', { query: 'All of' });
      expect(scopes.options.every((o) => o.id.endsWith('|'))).toBe(true);
    });

    it('all sit behind the permission to manage approvals', () => {
      for (const key of ['approval-users', 'approval-groups', 'approval-roles', 'approval-branches', 'approval-trigger-fields', 'approval-comparisons', 'approval-switch-scopes']) {
        expect(sources.getLookupSource(key)?.permission).toBe('approvals:manage');
      }
    });
  });

  describe('the paged lists', () => {
    it('pages staff by name and finds them by text', async () => {
      const page = await c.approvalConfig.pageStaff({ query: tag });
      expect(page.rows.map((r) => r.name)).toEqual([`${tag} Boss`, `${tag} Clerk`]);
      expect((await c.approvalConfig.pageStaff({ query: 'zzz-nobody' })).rows).toHaveLength(0);
    });

    it('reads approver settings only for the people on screen', async () => {
      await c.approvalConfig.saveProfile(companyId, { userId: clerk, approverUserId: boss, limits: [{ documentKind: 'sales_order', maxAmount: 100, unlimited: false }] }, actor, reason);
      const profiles = await c.approvalConfig.profilesFor(companyId, [clerk]);
      expect(profiles).toHaveLength(1);
      expect(profiles[0]?.limits.map((l) => l.documentKind)).toEqual(['sales_order']);
      expect(await c.approvalConfig.profilesFor(companyId, [])).toEqual([]);
      expect(await c.approvalConfig.profilesFor(companyId, [boss])).toEqual([]);
    });

    it('pages groups with their members in order', async () => {
      const page = await c.approvalConfig.pageGroups(companyId, { query: tag });
      expect(page.rows).toHaveLength(1);
      expect(page.rows[0]?.members.map((m) => m.userId)).toEqual([boss, clerk]);
    });

    it('pages workflows by code and names each current version in one query', async () => {
      for (let i = 0; i < 30; i++) await c.approvalConfig.createWorkflow(companyId, { code: `${tag}-W${String(i).padStart(2, '0')}`, name: `${tag} workflow ${String(i)}`, trigger: 'sales_order.submitted' }, actor);
      const first = await c.approvalConfig.pageWorkflows(companyId, { query: tag });
      expect(first.rows).toHaveLength(25);
      const second = await c.approvalConfig.pageWorkflows(companyId, { query: tag, cursor: first.nextCursor });
      expect(second.rows).toHaveLength(5);
      expect(new Set([...first.rows, ...second.rows].map((r) => r.id)).size).toBe(30);
      expect(await c.approvalConfig.versionsByIds([])).toEqual([]);
    });

    it('splits switches into company-wide ones and a page of branch exceptions', async () => {
      const branch = (await db.select().from(schema.branches).where(eq(schema.branches.code, `A${tag}`)))[0]?.id ?? '';
      await c.approvalConfig.setSwitch(companyId, { module: 'sales', trigger: null, branchId: null, enabled: false }, actor, reason);
      await c.approvalConfig.setSwitch(companyId, { module: 'sales', trigger: 'sales_order.submitted', branchId: branch, enabled: true }, actor, reason);
      expect((await c.approvalConfig.companySwitches(companyId)).every((s) => s.branchId === null)).toBe(true);
      const page = await c.approvalConfig.pageBranchSwitches(companyId, {});
      expect(page.rows.every((s) => s.branchId !== null)).toBe(true);
      expect(page.rows.map((s) => s.branchId)).toContain(branch);
      await c.approvalConfig.setSwitch(companyId, { module: 'sales', trigger: null, branchId: null, enabled: true }, actor, reason);
    });

    it('pages what is waiting, oldest first, and counts what is overdue in the database', async () => {
      c.approvals.registerDocument('sales_order', { snapshot: () => Promise.resolve({}), onReleased: () => Promise.resolve(), onRejected: () => Promise.resolve(), onReopened: () => Promise.resolve() });
      const wf = await c.approvalConfig.createWorkflow(companyId, { code: `${tag}-PEND`, name: `${tag} pending`, trigger: 'sales_order.submitted' }, actor);
      await c.approvalConfig.saveDraft(companyId, wf.id, { conditions: { op: 'eq', field: 'customer.id', value: customerId }, steps: [{ sequence: 1, name: 'Boss', approver: { type: 'user', userId: boss } }] } as never, actor);
      await c.approvalConfig.publish(companyId, wf.id, actor, reason);
      const before = await c.approvals.pendingCounts(companyId);
      for (let i = 0; i < 27; i++) {
        await db.transaction((t) =>
          c.approvals.submit({ companyId, trigger: 'sales_order.submitted', documentId: `${tag}-doc-${String(i)}`, requestedBy: clerk, amount: 10 + i, snapshot: { customer: { id: customerId } } }, t),
        );
      }
      const counts = await c.approvals.pendingCounts(companyId);
      expect(counts.waiting - before.waiting).toBe(27);

      const first = await c.approvals.pendingPage(companyId, {});
      expect(first.rows).toHaveLength(25);
      expect(first.nextCursor).not.toBeNull();
      const second = await c.approvals.pendingPage(companyId, { cursor: first.nextCursor });
      expect(second.rows.length).toBeGreaterThanOrEqual(1);
      const ids = [...first.rows, ...second.rows].map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
      const dates = first.rows.map((r) => r.createdAt.getTime());
      expect([...dates].sort((a, b) => a - b)).toEqual(dates);
      expect(first.rows[0]?.openEntries.length).toBeGreaterThan(0);

      // Make two entries overdue; only their requests are counted and listed as overdue.
      const mine = await db.select().from(schema.approvalEntries).where(and(eq(schema.approvalEntries.approverUserId, boss), eq(schema.approvalEntries.status, 'open'))).limit(2);
      expect(mine).toHaveLength(2);
      for (const e of mine) await db.update(schema.approvalEntries).set({ dueAt: new Date(Date.now() - 3_600_000) }).where(eq(schema.approvalEntries.id, e.id));
      const overdue = await c.approvals.pendingCounts(companyId);
      expect(overdue.overdue - before.overdue).toBe(2);
      const onlyOverdue = await c.approvals.pendingPage(companyId, { overdueOnly: true });
      expect(onlyOverdue.rows.length).toBeGreaterThanOrEqual(1);
      expect(onlyOverdue.rows.every((r) => r.openEntries.some((e) => e.dueAt !== null && e.dueAt.getTime() < Date.now()))).toBe(true);
    });
  });
});
