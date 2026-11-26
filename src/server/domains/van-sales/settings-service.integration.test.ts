import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import type { getContainer } from '@/server/di/container';
import type { drizzleDb } from '@/server/db/drizzle/client';
import type * as schemaModule from '@/server/db/drizzle/schema';
import { holdLedgerSwitch } from '@/server/domains/stock/test-support';
import { VAN_SALES_DEFAULTS } from '@/lib/van-sales/settings';

/**
 * Van sales settings (database): off until switched on, changed with a reason and the version the person saw, refused when stale or
 * out of range (by the service and by the database itself), and every change in the decision log.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (url !== undefined && url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === undefined || url === '')('van sales settings (database)', () => {
  let c: ReturnType<typeof getContainer>;
  let db: typeof drizzleDb;
  let schema: typeof schemaModule;
  let companyId: string;
  const actor = { type: 'user' as const, id: 'van-settings-test' };
  const reason = { code: 'POLICY_CHANGE' };
  const on = { ...VAN_SALES_DEFAULTS, vanSell: true, preSell: true };

  let release: () => Promise<void> = () => Promise.resolve();

  beforeAll(async () => {
    // The company's van sales settings are one row that the other van sales database tests change; this file waits its turn.
    release = await holdLedgerSwitch(url);
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    await db.delete(schema.vanSalesSettings).where(eq(schema.vanSalesSettings.companyId, companyId));
  });

  afterAll(async () => {
    await release();
  });

  it('is off, with the built-in rules, until the company switches it on', async () => {
    const screen = await c.vanSalesSettings.screen(companyId);
    expect(screen).toEqual({ settings: VAN_SALES_DEFAULTS, version: 0, updatedBy: null, updatedAt: null });
    expect(screen.settings.vanSell).toBe(false);
    expect(screen.settings.preSell).toBe(false);
  });

  const logged = async () => (await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectType, 'van_sales_settings')).orderBy(asc(schema.decisionLog.occurredAt), asc(schema.decisionLog.id))).filter((l) => l.subjectId === companyId && l.action === 'van_sales_settings.changed');

  it('is changed with a reason and the version on screen, and the change is logged with what it was and what it became', async () => {
    // The decision log is append-only, so count only what this test adds.
    const already = (await logged()).length;
    const saved = await c.vanSalesSettings.save(companyId, actor, on, 0, reason);
    expect(saved).toMatchObject({ settings: on, version: 1, updatedBy: actor.id });
    expect(await c.vanSalesSettings.current(companyId)).toEqual(on);
    const next = { ...on, shortage: 'write_off' as const, shortageApprovalAbove: 0, overnightStock: true, position: 'require' as const, nearMetres: 150, offRoute: 'refuse' as const };
    expect((await c.vanSalesSettings.save(companyId, actor, next, 1, reason)).version).toBe(2);
    const log = await logged();
    expect(log).toHaveLength(already + 2);
    const last = log.at(-1);
    expect(last?.inputs).toMatchObject({ shortage: 'charge_rep', vanSell: true });
    expect(last?.outcome).toMatchObject({ shortage: 'write_off', nearMetres: 150 });
  });

  it('refuses a change made from an out-of-date screen, and leaves the settings as they were', async () => {
    const before = await c.vanSalesSettings.screen(companyId);
    await expect(c.vanSalesSettings.save(companyId, actor, { ...on, vanSell: false }, before.version - 1, reason)).rejects.toThrow('Someone else changed these settings');
    await expect(c.vanSalesSettings.save(companyId, actor, { ...on, vanSell: false }, 'x', reason)).rejects.toThrow('Reload the page');
    expect(await c.vanSalesSettings.screen(companyId)).toEqual(before);
  });

  it('refuses a missing or unknown reason, and values that are not allowed, in words', async () => {
    const v = (await c.vanSalesSettings.screen(companyId)).version;
    await expect(c.vanSalesSettings.save(companyId, actor, on, v, { code: '' })).rejects.toThrow();
    await expect(c.vanSalesSettings.save(companyId, actor, on, v, { code: 'NO_SUCH_REASON' })).rejects.toThrow();
    await expect(c.vanSalesSettings.save(companyId, actor, { ...on, shortage: 'ignore' }, v, reason)).rejects.toThrow('what happens to stock that is missing');
    await expect(c.vanSalesSettings.save(companyId, actor, { ...on, nearMetres: 3 }, v, reason)).rejects.toThrow('whole metres from 20 to 5000');
    await expect(c.vanSalesSettings.save(companyId, actor, { ...on, shortageApprovalAbove: -5 }, v, reason)).rejects.toThrow('from 0 up');
    expect((await c.vanSalesSettings.screen(companyId)).version).toBe(v);
  });

  it('is held to its rules by the database too, so no other path can store a wrong value', async () => {
    const bad = async (set: string) => await db.execute(sql.raw(`UPDATE van_sales_settings SET ${set} WHERE company_id = '${companyId}'`)).then(() => null, (e: unknown) => e as { message?: string; cause?: { message?: string } });
    for (const set of ["shortage = 'ignore'", "off_route = 'maybe'", "position = 'spy'", 'shortage_approval_above = -1', 'near_metres = 5', 'near_metres = 9000']) {
      const err = await bad(set);
      expect(err, set).not.toBeNull();
      expect(`${err?.message ?? ''} ${err?.cause?.message ?? ''}`, set).toContain('van_sales_settings_');
    }
  });

  it('numbers a van day from its own standard series', async () => {
    const n = await c.numbering.assign('van_day', { companyId, date: '2026-11-24' });
    expect(n.number).toMatch(/^VDY-26-\d{8}$/);
  });
});
