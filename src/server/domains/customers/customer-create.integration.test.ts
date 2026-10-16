import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AppContainer } from '@/server/di/container';
import type * as Schema from '@/server/db/drizzle/schema';
import type { drizzleDb as Db } from '@/server/db/drizzle/client';
import { emptyCustomerForm, newCustomerPayload } from '@/lib/customer-forms';
import { required } from '@/lib/values';

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

  it('pages customers by name with a keyset cursor, finds them by text, and never repeats one', async () => {
    const mark = `Pg${tag}`;
    for (let i = 0; i < 27; i++) await save({ name: `${mark} ${String(i).padStart(2, '0')}`, phone: `07${String(i).padStart(8, '0')}` });
    const first = await c.customers.pageCustomers(companyId, { query: mark });
    expect(first.rows).toHaveLength(25);
    expect(first.nextCursor).not.toBeNull();
    const second = await c.customers.pageCustomers(companyId, { query: mark, cursor: first.nextCursor });
    expect(second.rows).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.rows, ...second.rows].map((r) => r.id)).size).toBe(27);
    expect(first.rows.map((r) => r.name)).toEqual([...first.rows.map((r) => r.name)].sort());
    expect((await c.customers.pageCustomers(companyId, { query: `${mark.toLowerCase()} 07` })).rows.map((r) => r.name)).toEqual([`${mark} 07`]);
    expect((await c.customers.pageCustomers(companyId, { query: '07000000' })).rows.length).toBeGreaterThan(0);
    expect((await c.customers.pageCustomers(companyId, { query: '%' })).rows).toHaveLength(0);
  });

  it('pages profiles by code and finds one by id for its words', async () => {
    const codes = [];
    for (let i = 0; i < 26; i++) {
      const code = `PP${tag}${String(i).padStart(2, '0')}`;
      codes.push(code);
      await db.insert(schema.customerProfiles).values({ companyId, code, name: `Paged ${code}`, accountType: 'cash' });
    }
    const first = await c.customers.pageProfiles(companyId, { query: `PP${tag}` });
    expect(first.rows.map((r) => r.code)).toEqual(codes.slice(0, 25));
    const second = await c.customers.pageProfiles(companyId, { query: `PP${tag}`, cursor: first.nextCursor });
    expect(second.rows.map((r) => r.code)).toEqual(codes.slice(25));
    expect((await c.customers.getProfile(companyId, required(second.rows[0]).id))?.code).toBe(codes[25]);
    expect(await c.customers.getProfile(randomUUID(), required(second.rows[0]).id)).toBeNull();
  });

  it('offers only the open values of a dimension of this company, by code', async () => {
    const [dim] = await db.insert(schema.dimensions).values({ companyId, code: `DM${tag}`, name: 'Test dim' }).returning();
    const dimId = required(dim).id;
    await db.insert(schema.dimensionValues).values([
      { dimensionId: dimId, dimensionCode: `DM${tag}`, code: 'OPEN', name: 'Open value' },
      { dimensionId: dimId, dimensionCode: `DM${tag}`, code: 'OLD', name: 'Retired', isActive: false },
      { dimensionId: dimId, dimensionCode: `DM${tag}`, code: 'HELD', name: 'Blocked', blocked: true },
    ]);
    const { getLookupSource } = await import('@/server/domains/lookups/sources');
    const source = getLookupSource('customer-dimension-values');
    if (source === undefined) throw new Error('no source');
    const found = await source.search({ companyId, query: '', limit: 20, after: null, filters: { dimension: dimId } });
    expect(found.options.map((o) => o.id)).toEqual(['OPEN']);
    expect((await source.search({ companyId: randomUUID(), query: '', limit: 20, after: null, filters: { dimension: dimId } })).options).toHaveLength(0);
    await expect(source.search({ companyId, query: '', limit: 20, after: null, filters: {} })).rejects.toThrow();
  });
});
