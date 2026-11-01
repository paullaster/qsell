import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { has } from '@/lib/values';
import type * as mod_server_di_container from '@/server/di/container';
import type * as mod_server_db_drizzle_client from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';
import type * as BranchActions from './actions';

const { requirePermission } = vi.hoisted(() => ({ requirePermission: vi.fn() }));
vi.mock('@/server/domains/access-control/guard', async (original) => ({ ...(await original<Record<string, unknown>>()), requirePermission }));
vi.mock('@/server/domains/finance/action-runner', () => ({ injectedDelay: () => Promise.resolve() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

/**
 * Where a branch is on the map, against a real database: the rule that a pin is both numbers or neither and a real place, the
 * actions that set and clear it (one permission each, this company only, in the decision log), and what the list shows.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

describe.skipIf(!has(url))('branch map pins (database)', () => {
  let db: typeof mod_server_db_drizzle_client.drizzleDb;
  let schema: typeof mod_server_db_drizzle_schema;
  let c: ReturnType<typeof mod_server_di_container.getContainer>;
  let actions: typeof BranchActions;
  let companyId: string;
  const code = () => `PN${randomUUID().slice(0, 8)}`.toUpperCase();
  const branch = async () => (await db.insert(schema.branches).values({ companyId, code: code(), name: 'Pin test' }).returning())[0]?.id ?? '';
  const history = async (id: string) => (await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectId, id)).orderBy(schema.decisionLog.occurredAt)).map((r) => [r.action, r.fromState, r.toState]);
  const row = async (id: string) => (await db.select().from(schema.branches).where(eq(schema.branches.id, id)))[0];

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    actions = await import('./actions');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
  });
  beforeEach(() => {
    requirePermission.mockReset().mockResolvedValue('user-1');
  });

  describe('the database', () => {
    it('keeps a pin whole: both numbers or neither, and a place that exists', async () => {
      const id = await branch();
      expect(await row(id)).toMatchObject({ latitude: null, longitude: null });
      await db.execute(sql`UPDATE branches SET latitude = -1.29, longitude = 36.82 WHERE id = ${id}`);
      expect(await row(id)).toMatchObject({ latitude: -1.29, longitude: 36.82 });
      await expect(db.execute(sql`UPDATE branches SET latitude = 5 WHERE id = ${id}`)).resolves.toBeDefined();
      for (const bad of [sql`UPDATE branches SET longitude = NULL WHERE id = ${id}`, sql`UPDATE branches SET latitude = 91, longitude = 0 WHERE id = ${id}`, sql`UPDATE branches SET latitude = 0, longitude = -181 WHERE id = ${id}`]) {
        await expect(db.execute(bad)).rejects.toThrow();
      }
      const half = await branch();
      await expect(db.execute(sql`UPDATE branches SET latitude = 1 WHERE id = ${half}`)).rejects.toThrow();
    });
  });

  describe('the actions', () => {
    it('set a pin, show it in the list with its label, time and who set it, and leave a note in the decision log', async () => {
      const id = await branch();
      const set = await actions.setBranchPinAction(id, { latitude: '-1.286389', longitude: ' 36.817223 ', label: '  Moi Avenue shop front  ' });
      expect(set).toMatchObject({ ok: true, data: { id, pin: { latitude: -1.286389, longitude: 36.817223, label: 'Moi Avenue shop front' } } });
      expect(set.ok && set.data.pin?.setAt).toEqual(expect.any(String));
      expect(await row(id)).toMatchObject({ pinSetBy: 'user-1', pinLabel: 'Moi Avenue shop front' });
      expect(await history(id)).toEqual([['branches.pin_set', 'no pin', '-1.286389,36.817223']]);
      await actions.setBranchPinAction(id, { latitude: -1.3, longitude: 36.8 });
      expect((await history(id)).at(-1)).toEqual(['branches.pin_set', '-1.286389,36.817223', '-1.3,36.8']);
      expect((await row(id))?.pinLabel).toBeNull();
    });

    it('refuse what is not a place, in plain words, and change nothing', async () => {
      const id = await branch();
      expect(await actions.setBranchPinAction(id, { latitude: '', longitude: '36' })).toMatchObject({ ok: false, error: 'Give both the latitude and the longitude as numbers.' });
      expect(await actions.setBranchPinAction(id, { latitude: 95, longitude: 36 })).toMatchObject({ ok: false, error: 'A latitude is between -90 and 90.' });
      expect(await actions.setBranchPinAction(id, { latitude: 1, longitude: 'east' })).toMatchObject({ ok: false });
      expect(await row(id)).toMatchObject({ latitude: null, longitude: null, pinSetAt: null });
    });

    it('take a pin off, and say so in the decision log', async () => {
      const id = await branch();
      await actions.setBranchPinAction(id, { latitude: 1, longitude: 2, label: 'x' });
      expect(await actions.clearBranchPinAction(id)).toMatchObject({ ok: true, data: { pin: null } });
      expect(await row(id)).toMatchObject({ latitude: null, longitude: null, pinLabel: null, pinSetAt: null, pinSetBy: null });
      expect((await history(id)).at(-1)).toEqual(['branches.pin_cleared', '1,2', 'no pin']);
    });

    it('ask for the manage permission, and only for it', async () => {
      const id = await branch();
      await actions.setBranchPinAction(id, { latitude: 1, longitude: 2 });
      await actions.clearBranchPinAction(id);
      expect(requirePermission.mock.calls.map((call: unknown[]) => call.at(0))).toEqual(['branches:manage', 'branches:manage']);
    });

    it('stop at the permission check: nobody without it changes anything', async () => {
      const id = await branch();
      requirePermission.mockRejectedValue(new Error('Forbidden'));
      expect((await actions.setBranchPinAction(id, { latitude: 1, longitude: 2 })).ok).toBe(false);
      expect(await row(id)).toMatchObject({ latitude: null });
    });

    it('only touch this company’s branches: another company’s, or one that does not exist, is "not found"', async () => {
      const tag = randomUUID().slice(0, 6);
      // A database with two companies does not say which is "the" company; the actions are asked about ours.
      const ours = await c.companySettings.ensureSeeded();
      const spy = vi.spyOn(c.companySettings, 'ensureSeeded').mockResolvedValue(ours);
      const otherCompany = (await db.insert(schema.companySettings).values({ legalName: `Other ${tag}`, tradingName: `Other ${tag}`, email: `o-${tag}@example.test`, phone: '0', streetAddress: '1', city: 'N', countyOrState: 'N', postalCode: '0', kraPin: `P${tag}` }).returning())[0]?.id ?? '';
      try {
        const foreign = (await db.insert(schema.branches).values({ companyId: otherCompany, code: code(), name: 'Foreign' }).returning())[0]?.id ?? '';
        expect(await actions.setBranchPinAction(foreign, { latitude: 1, longitude: 2 })).toMatchObject({ ok: false, error: 'That branch does not exist.' });
        expect(await actions.clearBranchPinAction(foreign)).toMatchObject({ ok: false, error: 'That branch does not exist.' });
        expect(await actions.clearBranchPinAction(randomUUID())).toMatchObject({ ok: false, error: 'That branch does not exist.' });
        expect(await row(foreign)).toMatchObject({ latitude: null });
      } finally {
        spy.mockRestore();
        await db.delete(schema.companySettings).where(eq(schema.companySettings.id, otherCompany));
      }
    });

    it('show a branch with no pin as having none', async () => {
      const id = await branch();
      const ours = await c.companySettings.ensureSeeded();
      const spy = vi.spyOn(c.companySettings, 'ensureSeeded').mockResolvedValue(ours);
      const page = await actions.branchesPageAction({ query: (await row(id))?.code ?? '' }).finally(() => spy.mockRestore());
      expect(page).toMatchObject({ ok: true, data: { rows: [{ id, pin: null }] } });
    });
  });
});
