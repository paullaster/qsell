import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AppContainer } from '@/server/di/container';
import type * as Schema from '@/server/db/drizzle/schema';
import type { drizzleDb as Db } from '@/server/db/drizzle/client';
import { emptyCustomerForm, newCustomerPayload } from '@/lib/customer-forms';

/**
 * The quick new-customer form against a real database: what is sent is saved the way the form meant it,
 * a repeated email is refused in words, and the profile list the form offers carries what it fills in.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL ?? '';
if (url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === '')('new customer (database)', () => {
  let c: AppContainer;
  let db: typeof Db;
  let schema: typeof Schema;
  let companyId = '';
  const tag = randomUUID().slice(0, 6);

  const save = (over: Partial<ReturnType<typeof emptyCustomerForm>>) => {
    const checked = newCustomerPayload({ ...emptyCustomerForm(), name: `Cust ${tag}`, ...over });
    if (!checked.ok) throw new Error(checked.error);
    return c.customers.saveCustomer(companyId, { ...checked.payload, blocked: 'none' });
  };

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
  });

  it('saves a cash customer with a number from the series and no credit terms', async () => {
    const row = await save({ email: `cash-${tag}@example.test`, phone: '0712000111', buyerKraPin: 'a123456789z' });
    expect(row.number).toMatch(/\S/);
    expect(row).toMatchObject({ name: `Cust ${tag}`, accountType: 'cash', email: `cash-${tag}@example.test`, buyerKraPin: 'A123456789Z', blocked: 'none', isActive: true });
    expect(Number(row.creditLimit)).toBe(0);
    expect(row.paymentTermDays).toBe(0);
  });

  it('saves a credit customer with its limit and terms', async () => {
    const row = await save({ name: `Credit ${tag}`, accountType: 'credit', creditLimit: '2500', paymentTermDays: '30' });
    expect(row.accountType).toBe('credit');
    expect(Number(row.creditLimit)).toBe(2500);
    expect(row.paymentTermDays).toBe(30);
  });

  it('refuses a second customer with the same email, in words a person can read', async () => {
    await save({ name: `Dup ${tag}`, email: `dup-${tag}@example.test` });
    await expect(save({ name: `Dup two ${tag}`, email: `DUP-${tag}@example.test` })).rejects.toThrow(/already exists/);
  });

  it('offers the profiles, with the account type and terms they bring', async () => {
    const [profile] = await db.insert(schema.customerProfiles).values({ companyId, code: `P${tag}`, name: `Profile ${tag}`, accountType: 'credit', creditLimit: '900', paymentTermDays: 14 }).returning();
    await db.insert(schema.customerProfiles).values({ companyId, code: `Q${tag}`, name: `Retired ${tag}`, accountType: 'cash', isActive: false });
    const { getLookupSource } = await import('@/server/domains/lookups/sources');
    const source = getLookupSource('customer-profiles');
    if (source === undefined) throw new Error('no source');
    const found = await source.search({ companyId, query: tag, limit: 20, after: null, filters: {} });
    expect(found.options.map((o) => o.label)).toEqual([`Profile ${tag}`]);
    expect(found.options[0]).toMatchObject({ id: profile?.id, badge: 'Credit', meta: { accountType: 'credit', creditLimit: '900.00', paymentTermDays: '14' } });
    const types = getLookupSource('customer-account-types');
    const all = await types?.search({ companyId, query: '', limit: 20, after: null, filters: {} });
    expect(all?.options.map((o) => o.id)).toEqual(['cash', 'credit']);
  });
});
