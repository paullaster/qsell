import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { getContainer } from '@/server/di/container';
import type { drizzleDb } from '@/server/db/drizzle/client';
import type * as schemaModule from '@/server/db/drizzle/schema';
import { AccessDeniedError } from '@/server/domains/access-control/engine';
import { businessTimeZone, followBusinessTimeZone } from '@/server/kernel/numbering/business-date';
import type * as BusinessTimeActions from './business-time-actions';
import { BusinessTimeError } from './business-time-service';

const { requirePermission } = vi.hoisted(() => ({ requirePermission: vi.fn() }));
vi.mock('@/server/domains/access-control/guard', async (original) => ({ ...(await original<Record<string, unknown>>()), requirePermission }));
vi.mock('@/server/domains/finance/action-runner', () => ({ injectedDelay: () => Promise.resolve() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

/**
 * The business time zone, against a real database: kept on the company row, changed only with a reason and the explicit permission,
 * refused in words when it cannot be used, written to the decision log with who changed it from what to what and why.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (url !== undefined && url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === undefined || url === '')('the business time zone (database)', () => {
  let c: ReturnType<typeof getContainer>;
  let db: typeof drizzleDb;
  let schema: typeof schemaModule;
  let companyId: string;
  let actions: typeof BusinessTimeActions;
  const actor = { type: 'user' as const, id: 'business-time-test' };
  const reason = { code: 'POLICY_CHANGE' };
  const stored = async (): Promise<string> => (await db.select({ z: schema.companySettings.timezone }).from(schema.companySettings).where(eq(schema.companySettings.id, companyId)))[0]?.z ?? '';
  const say = async (work: Promise<unknown>): Promise<string> => await work.then(() => 'done', (e: unknown) => (e instanceof BusinessTimeError || (e instanceof Error && e.name === 'ReasonError') ? e.message : `unexpected: ${String(e)}`));
  const entries = async () => await db.select().from(schema.decisionLog).where(and(eq(schema.decisionLog.subjectId, companyId), eq(schema.decisionLog.action, 'company.timezone_changed'))).orderBy(schema.decisionLog.occurredAt);

  const putBack = async () => {
    await db.update(schema.companySettings).set({ timezone: 'Africa/Nairobi' }).where(eq(schema.companySettings.id, companyId));
    followBusinessTimeZone('Africa/Nairobi');
  };

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    actions = await import('./business-time-actions');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    await putBack();
  });
  beforeEach(() => {
    requirePermission.mockReset().mockResolvedValue('business-time-test');
  });
  // What is set here must not leak into other tests that share the database.
  afterAll(putBack);

  it('is Africa/Nairobi until it is changed, as it has always been, and the screen says what the clock reads there', async () => {
    const view = await c.businessTime.view(companyId);
    expect(view).toMatchObject({ timeZone: 'Africa/Nairobi', offset: 'UTC+03:00', builtIn: 'Africa/Nairobi' });
    expect(view.localNow).toMatch(/^\d{2} \w{3} \d{4}, \d{2}:\d{2}$/);
    expect((await c.companySettings.ensureSeeded()).timezone).toBe('Africa/Nairobi');
  });

  it('is changed with a reason, kept on the company row, followed by this process at once, and logged with who, from what, to what and why', async () => {
    const had = (await entries()).length;
    const view = await c.businessTime.set(companyId, ' Europe/London ', actor, { code: 'POLICY_CHANGE', text: 'Head office moved to London' });
    expect(view).toMatchObject({ timeZone: 'Europe/London', builtIn: 'Africa/Nairobi' });
    expect(await stored()).toBe('Europe/London');
    expect(businessTimeZone()).toBe('Europe/London');
    // The next read of the company row (every request, every job) says the same.
    expect((await c.companySettings.ensureSeeded()).timezone).toBe('Europe/London');
    const log = await entries();
    expect(log).toHaveLength(had + 1);
    expect(log.at(-1)).toMatchObject({ actorType: 'user', actorId: actor.id, fromState: 'Africa/Nairobi', toState: 'Europe/London', reasonCode: 'POLICY_CHANGE', reasonText: 'Head office moved to London' });
  });

  it('refuses what cannot work, each in words, and keeps the zone and the log as they were', async () => {
    const zone = await stored();
    const before = (await entries()).length;
    expect(await say(c.businessTime.set(companyId, zone, actor, reason))).toBe(`The business time zone is already ${zone}.`);
    expect(await say(c.businessTime.set(companyId, '', actor, reason))).toBe('Choose the business time zone.');
    expect(await say(c.businessTime.set(companyId, undefined, actor, reason))).toBe('Choose the business time zone.');
    expect(await say(c.businessTime.set(companyId, 'Mars/Olympus_Mons', actor, reason))).toContain('is not a time zone this system knows');
    expect(await say(c.businessTime.set(companyId, 'EST', actor, reason))).toContain('is not a time zone this system knows');
    expect(await say(c.businessTime.set(companyId, 'Africa/Nairobi', actor, { code: '' }))).toBe('A reason is required.');
    expect(await say(c.businessTime.set(companyId, 'Africa/Nairobi', actor, { code: 'NO_SUCH_REASON' }))).toContain('does not exist');
    // Another company's reasons are not this company's: nothing is changed for a company that is not ours.
    expect(await say(c.businessTime.set(randomCompany(), 'Africa/Nairobi', actor, reason))).toContain('does not exist');
    expect(await stored()).toBe(zone);
    expect(businessTimeZone()).toBe(zone);
    expect(await entries()).toHaveLength(before);
  });

  it('makes one change when two people make the same one at the same moment', async () => {
    const before = (await entries()).length;
    const both = await Promise.all([say(c.businessTime.set(companyId, 'Asia/Tokyo', actor, reason)), say(c.businessTime.set(companyId, 'Asia/Tokyo', actor, reason))]);
    expect(both.filter((r) => r === 'done')).toHaveLength(1);
    expect(both.filter((r) => r === 'The business time zone is already Asia/Tokyo.')).toHaveLength(1);
    expect(await stored()).toBe('Asia/Tokyo');
    expect(await entries()).toHaveLength(before + 1);
  });

  it('cannot be given a value of the wrong shape by any door, the database refuses it', async () => {
    for (const bad of ['', 'bad zone!', 'Africa//Nairobi', '/Africa/Nairobi', 'x'.repeat(65), "Africa/Nairobi'; drop table x;--"]) {
      await expect(db.update(schema.companySettings).set({ timezone: bad }).where(eq(schema.companySettings.id, companyId))).rejects.toThrow();
    }
    expect(await stored()).toBe('Asia/Tokyo');
  });

  it('is changed through the action only by someone with the timezone:manage permission, checked on the server', async () => {
    requirePermission.mockRejectedValue(new AccessDeniedError('timezone:manage', { allowed: false, reason: 'deny-grant' }));
    expect(await actions.saveBusinessTimeAction('Europe/Paris', reason)).toEqual({ ok: false, error: 'You do not have permission to do that.', forbidden: true });
    expect(await actions.businessTimeScreenAction()).toEqual({ ok: false, error: 'You do not have permission to do that.', forbidden: true });
    expect(requirePermission).toHaveBeenCalledWith('timezone:manage');
    expect(await stored()).toBe('Asia/Tokyo');

    requirePermission.mockResolvedValue('business-time-test');
    expect(await actions.saveBusinessTimeAction('Mars/Olympus_Mons', reason)).toMatchObject({ ok: false, error: expect.stringContaining('is not a time zone this system knows') as string });
    expect(await actions.saveBusinessTimeAction('Europe/Paris', { code: '' })).toEqual({ ok: false, error: 'A reason is required.' });
    const done = await actions.saveBusinessTimeAction('Europe/Paris', { code: 'POLICY_CHANGE', text: 'Moved' });
    expect(done).toMatchObject({ ok: true, data: { timeZone: 'Europe/Paris' } });
    expect(await stored()).toBe('Europe/Paris');
    // Garbage in place of the reason is a refusal in words, never a crash.
    expect(await actions.saveBusinessTimeAction('Asia/Tokyo', 42)).toEqual({ ok: false, error: 'A reason is required.' });
    expect(await actions.saveBusinessTimeAction(['Asia/Tokyo'], reason)).toMatchObject({ ok: false });
  });

  it('is offered only to those who may change it: the picker for the zones and for the reasons is behind the same permission', async () => {
    const { getLookupSource } = await import('@/server/domains/lookups/sources');
    for (const key of ['business-timezones', 'business-time-reasons']) {
      expect(getLookupSource(key)?.permission, key).toBe('timezone:manage');
    }
  });
});

const randomCompany = (): string => '00000000-0000-4000-8000-000000000000';
