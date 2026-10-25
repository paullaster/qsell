import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { has } from '@/lib/values';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import type { OrderRepository } from './repository';

/** A shopper's own orders, a page at a time, against a real database.   TEST_DATABASE_URL=postgres://... pnpm test */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!has(url))('a shopper’s own orders (database)', () => {
  let db: DrizzleDb;
  let repo: OrderRepository;
  let branchId: string;
  const tag = randomUUID().slice(0, 6).toUpperCase();
  const me = `acct-${tag}`;
  const other = `other-${tag}`;

  async function order(n: number, userId: string, minutesAgo: number) {
    const id = `ow_${tag}_${String(n).padStart(2, '0')}`;
    const created = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    await db.execute(sql`INSERT INTO orders (id, order_number, user_id, branch_id, customer_name, customer_email, customer_phone, shipping_address, subtotal, tax, shipping_fee, total_amount, payment_method, status, created_at)
      VALUES (${id}, ${`OW-${tag}-${String(n).padStart(2, '0')}`}, ${userId}, ${branchId}::uuid, 'Buyer', ${`b${n}-${tag}@x.test`}, '0700000000', '{"street":"s","city":"c","countyOrState":"x","country":"k"}'::jsonb, 100, 16, 0, 116, 'mpesa_daraja', 'pending', ${created}::timestamptz)`);
    return id;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    ({ drizzleDb: db } = await import('@/server/db/drizzle/client'));
    const schema = await import('@/server/db/drizzle/schema');
    const { OrderRepository } = await import('./repository');
    repo = new OrderRepository(db);
    const [company] = await db
      .insert(schema.companySettings)
      .values({
        legalName: 'OW',
        tradingName: 'OW',
        email: 'a@b.c',
        phone: '1',
        streetAddress: 's',
        city: 'c',
        countyOrState: 'x',
        postalCode: '1',
        kraPin: 'P',
      })
      .returning();
    const [branch] = await db
      .insert(schema.branches)
      .values({ companyId: company.id, code: `OW${tag}`, name: 'OW branch', isDefault: true })
      .returning();
    branchId = branch.id;
    for (let n = 1; n <= 5; n++) await order(n, me, n);
    for (let n = 6; n <= 8; n++) await order(n, other, n);
  });

  it('returns only the shopper’s orders, newest first, each once across pages', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof repo.pageForOwner>> = await repo.pageForOwner({
        ids: [me],
        tradeCustomerId: null,
        limit: 2,
        cursor,
      });
      expect(page.rows.length).toBeLessThanOrEqual(2);
      seen.push(...page.rows.map((o) => o.orderNumber));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual([1, 2, 3, 4, 5].map((n) => `OW-${tag}-0${String(n)}`));
  });

  it('never returns another shopper’s orders', async () => {
    const page = await repo.pageForOwner({ ids: [other], tradeCustomerId: null });
    expect(page.rows.map((o) => o.orderNumber)).toEqual(
      [6, 7, 8].map((n) => `OW-${tag}-0${String(n)}`),
    );
    expect(page.rows.every((o) => o.userId === other)).toBe(true);
  });

  it('returns nothing when the shopper has no marks at all', async () => {
    expect(await repo.pageForOwner({ ids: [''], tradeCustomerId: null })).toEqual({
      rows: [],
      nextCursor: null,
    });
    expect(await repo.pageForOwner({ ids: [`nobody-${tag}`], tradeCustomerId: null })).toEqual({
      rows: [],
      nextCursor: null,
    });
  });
});
