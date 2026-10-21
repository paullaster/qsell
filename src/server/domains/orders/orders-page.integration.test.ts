import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { has } from '@/lib/values';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';
import type { OrderRepository } from './repository';

/** The admin orders list, a page at a time, against a real database.   TEST_DATABASE_URL=postgres://... pnpm test */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!has(url))('the orders list (database)', () => {
  let db: DrizzleDb;
  let schema: typeof mod_server_db_drizzle_schema;
  let repo: OrderRepository;
  let branchId: string;
  const tag = randomUUID().slice(0, 6).toUpperCase();
  const ids: string[] = [];

  /** An order made `minutesAgo` minutes ago, with `items` lines. */
  async function order(
    n: number,
    o: {
      status?: string;
      minutesAgo?: number;
      name?: string;
      phone?: string;
      email?: string;
      tracking?: string;
      items?: number;
      at?: string;
    } = {},
  ) {
    const id = `op_${tag}_${String(n).padStart(2, '0')}`;
    ids.push(id);
    const created = o.at ?? new Date(Date.now() - (o.minutesAgo ?? n) * 60_000).toISOString();
    await db.execute(sql`INSERT INTO orders (id, order_number, user_id, branch_id, customer_name, customer_email, customer_phone, shipping_address, subtotal, tax, shipping_fee, total_amount, payment_method, status, tracking_number, created_at)
      VALUES (${id}, ${`OP-${tag}-${String(n).padStart(2, '0')}`}, 'u', ${branchId}::uuid, ${o.name ?? `Buyer ${tag} ${n}`}, ${o.email ?? `b${n}-${tag}@x.test`}, ${o.phone ?? `07000${String(n).padStart(5, '0')}`}, '{"street":"s","city":"c","countyOrState":"x","country":"k"}'::jsonb, 100, 16, 0, 116, 'mpesa_daraja', ${o.status ?? 'pending'}, ${o.tracking ?? null}, ${created}::timestamptz)`);
    for (let i = 0; i < (o.items ?? 2); i++) {
      await db
        .insert(schema.orderItems)
        .values({
          orderId: id,
          productId: `p${i}`,
          productName: `Item ${n}-${i}`,
          sku: `S${i}`,
          quantity: i + 1,
          unitPrice: '10.00',
          totalPrice: String((i + 1) * 10),
          imageUrl: '',
        });
    }
    return id;
  }
  const mine = (rows: { orderNumber: string }[]) =>
    rows.filter((r) => r.orderNumber.startsWith(`OP-${tag}-`)).map((r) => r.orderNumber);

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    ({ drizzleDb: db } = await import('@/server/db/drizzle/client'));
    schema = await import('@/server/db/drizzle/schema');
    const { OrderRepository } = await import('./repository');
    repo = new OrderRepository(db);
    const [company] = await db
      .insert(schema.companySettings)
      .values({
        legalName: 'OP',
        tradingName: 'OP',
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
      .values({ companyId: company.id, code: `OP${tag}`, name: 'OP branch', isDefault: true })
      .returning();
    branchId = branch.id;
    for (let n = 1; n <= 7; n++) await order(n, { status: n % 2 === 0 ? 'shipped' : 'pending' });
  });

  it('gives newest first, a page at a time, each order once and none missed, with their items', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof repo.page>> = await repo.page({
        query: tag,
        limit: 3,
        cursor,
      });
      pages += 1;
      expect(page.rows.length).toBeLessThanOrEqual(3);
      for (const o of page.rows) {
        expect(o.items).toHaveLength(2);
        expect(o.items.map((i) => i.productName).sort()).toEqual(
          [
            `Item ${o.orderNumber.slice(-2).replace(/^0/, '')}-0`,
            `Item ${o.orderNumber.slice(-2).replace(/^0/, '')}-1`,
          ].sort(),
        );
      }
      seen.push(...mine(page.rows));
      cursor = page.nextCursor;
    } while (cursor !== null && pages < 10);
    expect(pages).toBe(3);
    // order 1 is the newest (1 minute ago), 7 the oldest
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7].map((n) => `OP-${tag}-0${String(n)}`));
  });

  it('keeps orders made in the same instant in a steady order across pages', async () => {
    const at = new Date(Date.now() - 3_000_000).toISOString();
    for (let n = 20; n < 25; n++) await order(n, { at });
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<typeof repo.page>> = await repo.page({
        query: `OP-${tag}-2`,
        limit: 2,
        cursor,
      });
      seen.push(...page.rows.map((r) => r.orderNumber));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toHaveLength(5);
  });

  it('narrows by state', async () => {
    const shipped = await repo.page({ query: tag, status: 'shipped', limit: 50 });
    expect(mine(shipped.rows)).toEqual([`OP-${tag}-02`, `OP-${tag}-04`, `OP-${tag}-06`]);
    expect(shipped.rows.every((o) => o.status === 'shipped')).toBe(true);
    expect(mine((await repo.page({ query: tag, status: 'cancelled', limit: 50 })).rows)).toEqual(
      [],
    );
  });

  it('searches the number, the customer, the phone, the email and the tracking code, without case', async () => {
    await order(30, {
      name: `Wanjiru Kamau ${tag}`,
      phone: '0711222333',
      email: `wanjiru-${tag}@shop.test`,
      tracking: `TRK-${tag}-XYZ`,
    });
    for (const q of [
      `op-${tag}-30`,
      `wanjiru kamau ${tag.toLowerCase()}`,
      '0711222333',
      `WANJIRU-${tag}@SHOP`,
      `trk-${tag}-xyz`,
    ]) {
      expect(mine((await repo.page({ query: q, limit: 10 })).rows), q).toEqual([`OP-${tag}-30`]);
    }
  });

  it('treats the characters of a search as text, not as a pattern', async () => {
    await order(31, { name: `100%_sure ${tag}` });
    expect(mine((await repo.page({ query: `100%_sure ${tag}`, limit: 10 })).rows)).toEqual([
      `OP-${tag}-31`,
    ]);
    expect(mine((await repo.page({ query: `%${tag}`, limit: 50 })).rows)).toEqual([]);
    expect(await repo.page({ query: "'; DROP TABLE orders; --", limit: 5 })).toMatchObject({
      rows: [],
      nextCursor: null,
    });
  });

  it('starts from the top on a cursor that is not one of ours, and holds a page to a sane size', async () => {
    const top = await repo.page({ query: tag, limit: 2 });
    const junk = await repo.page({ query: tag, limit: 2, cursor: 'not-a-cursor' });
    expect(junk.rows.map((r) => r.id)).toEqual(top.rows.map((r) => r.id));
    expect((await repo.page({ query: tag, limit: 100000 })).rows.length).toBeLessThanOrEqual(100);
    expect((await repo.page({ query: tag, limit: 0 })).rows.length).toBe(1);
  });

  it('reads the items of a whole page in one go: an order with none has an empty list', async () => {
    await order(40, { items: 0 });
    const page = await repo.page({ query: `OP-${tag}-40`, limit: 5 });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]?.items).toEqual([]);
  });
});
