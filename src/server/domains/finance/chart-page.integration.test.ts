import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { drizzleDb as Db } from '@/server/db/drizzle/client';
import type * as Schema from '@/server/db/drizzle/schema';
import type { FinanceSetupService } from './setup-service';

/**
 * The chart of accounts is read a page at a time: account numbers that are digits sort as numbers,
 * the text search matches number or name (with % and _ taken literally), a page's last row leads to
 * the next page, and another company's accounts are never seen.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL ?? '';
if (url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === '')('the chart of accounts, a page at a time (database)', () => {
  let db: typeof Db;
  let schema: typeof Schema;
  let setup: FinanceSetupService;
  let companyId: string;
  let otherCompanyId: string;
  const tag = randomUUID().slice(0, 6).toUpperCase();

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    setup = mod.getContainer().finance.setup;
    const company = (name: string) =>
      db.insert(schema.companySettings).values({ legalName: name, tradingName: name, email: `${name}@example.test`, phone: '0', streetAddress: '1', city: 'N', countyOrState: 'N', postalCode: '0', kraPin: name }).returning();
    companyId = (await company(`Chart ${tag}`))[0].id;
    otherCompanyId = (await company(`Other ${tag}`))[0].id;
    const account = (company: string, no: string, name: string) =>
      db.insert(schema.glAccounts).values({ companyId: company, no, name, type: 'posting', category: 'assets', normalBalance: 'debit' });
    for (const [no, name] of [['100', 'Hundred'], ['9', 'Nine'], ['20', '50%_discount'], ['1000', 'Thousand'], ['A-1', 'Lettered']] as const) await account(companyId, no, name);
    await account(otherCompanyId, '5', 'Elsewhere');
  });

  const numbers = async (opts: Parameters<FinanceSetupService['accountsPage']>[1]) => (await setup.accountsPage(companyId, opts)).rows.map((r) => r.no);

  it('puts numeric account numbers in numeric order, then the lettered ones', async () => {
    expect(await numbers({})).toEqual(['9', '20', '100', '1000', 'A-1']);
  });

  it('pages by the last row, with no repeat and no gap', async () => {
    const first = await setup.accountsPage(companyId, { limit: 2 });
    expect(first.rows.map((r) => r.no)).toEqual(['9', '20']);
    expect(first.next).not.toBeNull();
    const second = await setup.accountsPage(companyId, { limit: 2, after: first.next });
    expect(second.rows.map((r) => r.no)).toEqual(['100', '1000']);
    const third = await setup.accountsPage(companyId, { limit: 2, after: second.next });
    expect(third.rows.map((r) => r.no)).toEqual(['A-1']);
    expect(third.next).toBeNull();
  });

  it('searches number or name, case-insensitively, taking % and _ literally', async () => {
    expect(await numbers({ query: 'thou' })).toEqual(['1000']);
    expect(await numbers({ query: '10' })).toEqual(['100', '1000']);
    expect(await numbers({ query: '50%_' })).toEqual(['20']);
    expect(await numbers({ query: '%' })).toEqual(['20']);
    expect(await numbers({ query: 'nothing like this' })).toEqual([]);
  });

  it('never shows another company’s accounts, and names accounts by id for the same company only', async () => {
    expect(await numbers({ query: 'Elsewhere' })).toEqual([]);
    const mine = (await setup.accountsPage(companyId, { query: 'Nine' })).rows[0];
    const theirs = (await setup.accountsPage(otherCompanyId, { query: 'Elsewhere' })).rows[0];
    if (mine === undefined || theirs === undefined) throw new Error('test data missing');
    expect(await setup.accountLabels(companyId, [mine.id, theirs.id])).toEqual({ [mine.id]: '9 Nine' });
    expect(await setup.accountLabels(companyId, [])).toEqual({});
  });
});
