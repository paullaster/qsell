import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AppContainer } from '@/server/di/container';
import type * as Schema from '@/server/db/drizzle/schema';
import type { drizzleDb as Db } from '@/server/db/drizzle/client';

/**
 * The branch settings against a real database: the keyset-paged list with its search, the rule that
 * a code is unique, and the one-default rule.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL ?? '';
if (url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === '')('branch settings (database)', () => {
  let c: AppContainer;
  let db: typeof Db;
  let schema: typeof Schema;
  let companyId = '';
  const tag = randomUUID().slice(0, 5).toUpperCase();

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    for (let i = 0; i < 30; i++) {
      await db.insert(schema.branches).values({ companyId, code: `${tag}${String(i).padStart(2, '0')}`, name: `Branch ${tag} ${String(i).padStart(2, '0')}` });
    }
  });

  it('pages by name with a keyset cursor and no repeats', async () => {
    const first = await c.branches.pageByCompany(companyId, { query: tag });
    expect(first.rows).toHaveLength(25);
    expect(first.nextCursor).not.toBeNull();
    const second = await c.branches.pageByCompany(companyId, { query: tag, cursor: first.nextCursor });
    expect(second.rows).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.rows, ...second.rows].map((r) => r.id)).size).toBe(30);
    expect(first.rows[0]?.name).toBe(`Branch ${tag} 00`);
  });

  it('finds a branch by code or by name, case-insensitively', async () => {
    expect((await c.branches.pageByCompany(companyId, { query: `${tag}07`.toLowerCase() })).rows.map((r) => r.code)).toEqual([`${tag}07`]);
    expect((await c.branches.pageByCompany(companyId, { query: `branch ${tag} 12` })).rows).toHaveLength(1);
    expect((await c.branches.pageByCompany(companyId, { query: 'no-such-branch-zzz' })).rows).toHaveLength(0);
  });

  it('refuses a second branch with the same code, in words a person can read', async () => {
    const { isUniqueViolation } = await import('@/server/domains/settings/errors');
    const duplicate = db.insert(schema.branches).values({ companyId, code: `${tag}00`, name: 'again' });
    await expect(duplicate).rejects.toSatisfy((error: unknown) => isUniqueViolation(error));
    expect(isUniqueViolation(new Error('something else'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });

  it('keeps one default: making another the default clears the old one', async () => {
    const [a] = (await c.branches.pageByCompany(companyId, { query: `${tag}01` })).rows;
    const [b] = (await c.branches.pageByCompany(companyId, { query: `${tag}02` })).rows;
    await c.branches.update(a?.id ?? '', { isDefault: true });
    await c.branches.update(b?.id ?? '', { isDefault: true });
    const rows = (await c.branches.pageByCompany(companyId, { query: tag })).rows;
    expect(rows.filter((r) => r.isDefault).map((r) => r.code)).toEqual([`${tag}02`]);
  });
});
