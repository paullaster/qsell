import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { getContainer } from '@/server/di/container';
import type { drizzleDb } from '@/server/db/drizzle/client';
import type * as schemaModule from '@/server/db/drizzle/schema';
import { CustomerCreditSettingsError } from './customer-credit-settings-service';

const url = process.env.TEST_DATABASE_URL;
if (url !== undefined && url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === undefined || url === '')('customer credit settings (database)', () => {
  let c: ReturnType<typeof getContainer>;
  let db: typeof drizzleDb;
  let schema: typeof schemaModule;
  let companyId: string;
  const actor = { type: 'user' as const, id: 'customer-credit-settings-test' };
  const reason = { code: 'POLICY_CHANGE' };

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    await db
      .delete(schema.customerCreditSettings)
      .where(eq(schema.customerCreditSettings.companyId, companyId));
  });

  afterAll(async () => {
    await db
      .delete(schema.customerCreditSettings)
      .where(eq(schema.customerCreditSettings.companyId, companyId));
  });

  it('starts with running display and no permission to proceed beyond credit', async () => {
    expect(await c.customerCreditSettings.get(companyId)).toEqual({
      creditLimitDisplay: 'running',
      allowOverCreditLimit: false,
    });
  });

  it('saves each choice independently and records who and why', async () => {
    expect(await c.customerCreditSettings.saveDisplay(companyId, 'static', actor, reason)).toEqual({
      creditLimitDisplay: 'static',
      allowOverCreditLimit: false,
    });
    expect(
      await c.customerCreditSettings.setAllowOverCreditLimit(companyId, true, reason, actor),
    ).toEqual({ creditLimitDisplay: 'static', allowOverCreditLimit: true });
    expect(await c.customerCreditSettings.get(companyId)).toEqual({
      creditLimitDisplay: 'static',
      allowOverCreditLimit: true,
    });
    const entries = await db
      .select()
      .from(schema.decisionLog)
      .where(eq(schema.decisionLog.subjectType, 'customer_credit_settings'));
    expect(entries.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        'customer_credit.display_changed',
        'customer_credit.over_limit_enabled',
      ]),
    );
  });

  it('refuses a display the company did not choose and leaves the saved choice alone', async () => {
    await expect(
      c.customerCreditSettings.saveDisplay(companyId, 'balance', actor, reason),
    ).rejects.toBeInstanceOf(CustomerCreditSettingsError);
    expect((await c.customerCreditSettings.get(companyId)).creditLimitDisplay).toBe('static');
  });
});
