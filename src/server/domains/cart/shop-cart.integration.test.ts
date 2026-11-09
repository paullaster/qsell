import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { has } from '@/lib/values';
import type { ShopCartService as Service } from './service';
import type { DrizzleDb } from '@/server/db/drizzle/client';

/** The saved cart and the reminder about a left cart, against a real database.   TEST_DATABASE_URL=postgres://... pnpm test */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!has(url))('saved cart and cart reminders (database)', () => {
  let service: typeof Service;
  let db: DrizzleDb;
  const tag = randomUUID().slice(0, 6);
  const now = new Date();
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

  const makeUser = async (n: number, extra: { verified?: boolean; role?: string; storeId?: string } = {}): Promise<string> => {
    const id = randomUUID();
    await db.execute(sql`INSERT INTO users (id, email, password_hash, name, role, email_verified_at, customer_store_id) VALUES (${id}::uuid, ${`c${String(n)}-${tag}@example.test`}, 'x', ${`Shopper ${String(n)}`}, ${extra.role ?? 'customer'}, ${extra.verified === false ? null : now.toISOString()}::timestamptz, ${extra.storeId ?? null})`);
    return id;
  };
  const backdate = async (userId: string, at: Date) => {
    await db.execute(sql`UPDATE shop_carts SET updated_at = ${at.toISOString()}::timestamptz WHERE user_id = ${userId}::uuid`);
  };
  const due = async (userId: string) => (await service.abandoned(now, 500, db)).filter((c) => c.userId === userId);

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    ({ ShopCartService: service } = await import('./service'));
    ({ drizzleDb: db } = await import('@/server/db/drizzle/client'));
  });

  it('keeps a shopper’s cart, replaces it whole, and ignores lines that cannot be right', async () => {
    const user = await makeUser(1);
    expect(await service.get(user)).toEqual([]);
    await service.save(user, [{ productId: 'a', quantity: 2 }, { productId: 'a', quantity: 9 }, { productId: '', quantity: 1 }, { productId: 'b', quantity: -3 }]);
    expect(await service.get(user)).toEqual([{ productId: 'a', quantity: 2 }]);
    await service.save(user, [{ productId: 'c', quantity: 1 }]);
    expect(await service.get(user)).toEqual([{ productId: 'c', quantity: 1 }]);
    await service.save(user, 'not a list');
    expect(await service.get(user)).toEqual([]);
  });

  it('never gives one shopper another’s cart', async () => {
    const one = await makeUser(2);
    const two = await makeUser(3);
    await service.save(one, [{ productId: 'a', quantity: 1 }]);
    expect(await service.get(two)).toEqual([]);
  });

  it('saving the same cart again does not start the idle clock over; changing it does', async () => {
    const user = await makeUser(4);
    await service.save(user, [{ productId: 'a', quantity: 1 }]);
    await backdate(user, hoursAgo(5));
    await service.save(user, [{ productId: 'a', quantity: 1 }]);
    expect((await due(user)).length).toBe(1);
    await service.save(user, [{ productId: 'a', quantity: 2 }]);
    expect(await due(user)).toEqual([]);
  });

  it('joins the browser’s cart with the account’s without doubling, and twice is the same as once', async () => {
    const user = await makeUser(5);
    await service.save(user, [{ productId: 'a', quantity: 2 }, { productId: 'b', quantity: 1 }]);
    const browser = [{ productId: 'a', quantity: 5 }, { productId: 'c', quantity: 3 }];
    const once = await service.merge(user, browser);
    expect(once).toEqual([{ productId: 'a', quantity: 5 }, { productId: 'b', quantity: 1 }, { productId: 'c', quantity: 3 }]);
    expect(await service.merge(user, browser)).toEqual(once);
    expect(await service.merge(user, [])).toEqual(once);
  });

  it('refuses a cart of more than a hundred lines by keeping the first hundred', async () => {
    const user = await makeUser(6);
    const saved = await service.save(user, Array.from({ length: 150 }, (_, i) => ({ productId: `p${String(i)}`, quantity: 1 })));
    expect(saved).toHaveLength(100);
  });

  it('clearing empties the cart and keeps the choice about reminders', async () => {
    const user = await makeUser(7);
    await service.save(user, [{ productId: 'a', quantity: 1 }]);
    const token = await service.optoutTokenOf(user);
    expect(await service.stopReminders(token ?? '')).toBe(true);
    await service.clear(user);
    expect(await service.get(user)).toEqual([]);
    await service.save(user, [{ productId: 'a', quantity: 1 }]);
    await backdate(user, hoursAgo(5));
    expect(await due(user)).toEqual([]);
  });

  describe('which carts are left behind', () => {
    it('a cart idle for the wait, with something in it, is due; a fresh one and an empty one are not', async () => {
      const idle = await makeUser(10);
      const fresh = await makeUser(11);
      const empty = await makeUser(12);
      for (const u of [idle, fresh]) await service.save(u, [{ productId: 'a', quantity: 1 }]);
      await service.save(empty, []);
      await backdate(idle, hoursAgo(4));
      await backdate(fresh, hoursAgo(1));
      await backdate(empty, hoursAgo(4));
      expect((await due(idle)).length).toBe(1);
      expect(await due(fresh)).toEqual([]);
      expect(await due(empty)).toEqual([]);
    });

    it('a cart older than a week is let go', async () => {
      const user = await makeUser(13);
      await service.save(user, [{ productId: 'a', quantity: 1 }]);
      await backdate(user, new Date(now.getTime() - 8 * 86_400_000));
      expect(await due(user)).toEqual([]);
    });

    it('once reminded, the same cart is not reminded again, and a changed cart waits out the week', async () => {
      const user = await makeUser(14);
      await service.save(user, [{ productId: 'a', quantity: 1 }]);
      await backdate(user, hoursAgo(5));
      const [candidate] = await due(user);
      expect(candidate).toBeDefined();
      expect(await service.markReminded(user, candidate?.updatedAt ?? now, now)).toBe(true);
      expect(await due(user)).toEqual([]);
      // Changed after the reminder and idle again: still inside the week, so no second reminder.
      await service.save(user, [{ productId: 'a', quantity: 4 }]);
      await backdate(user, hoursAgo(4));
      await db.execute(sql`UPDATE shop_carts SET reminded_at = ${hoursAgo(10).toISOString()}::timestamptz WHERE user_id = ${user}::uuid`);
      expect(await due(user)).toEqual([]);
    });

    it('a reminder is not recorded for a cart that has changed since it was decided', async () => {
      const user = await makeUser(15);
      await service.save(user, [{ productId: 'a', quantity: 1 }]);
      await backdate(user, hoursAgo(5));
      const [candidate] = await due(user);
      await service.save(user, [{ productId: 'a', quantity: 2 }]);
      expect(await service.markReminded(user, candidate?.updatedAt ?? now, now)).toBe(false);
    });

    it('a shopper who ordered after the cart changed is not reminded, by account id or by the shop’s customer id', async () => {
      const byAccount = await makeUser(16);
      const storeId = `store-${tag}`;
      const byStore = await makeUser(17, { storeId });
      for (const u of [byAccount, byStore]) {
        await service.save(u, [{ productId: 'a', quantity: 1 }]);
        await backdate(u, hoursAgo(5));
      }
      const order = async (userId: string, n: number) =>
        await db.execute(sql`INSERT INTO orders (id, order_number, user_id, customer_name, customer_email, customer_phone, shipping_address, subtotal, tax, shipping_fee, total_amount, payment_method) VALUES (${randomUUID()}, ${`ORD-${tag}-${String(n)}`}, ${userId}, 'x', 'x@example.test', '0700000000', '{}'::jsonb, 1, 0, 0, 1, 'mpesa_daraja')`);
      expect((await due(byAccount)).length).toBe(1);
      await order(byAccount, 1);
      await order(storeId, 2);
      expect(await due(byAccount)).toEqual([]);
      expect(await due(byStore)).toEqual([]);
    });

    it('never an unverified address, a suspended account, or anyone who is not a shopper', async () => {
      const unverified = await makeUser(18, { verified: false });
      const staff = await makeUser(19, { role: 'manager' });
      const suspended = await makeUser(20);
      await db.execute(sql`UPDATE users SET status = 'suspended' WHERE id = ${suspended}::uuid`);
      for (const u of [unverified, staff, suspended]) {
        await service.save(u, [{ productId: 'a', quantity: 1 }]);
        await backdate(u, hoursAgo(5));
        expect(await due(u)).toEqual([]);
      }
    });

    it('stopping reminders works from the link only, and a wrong link changes nothing', async () => {
      const user = await makeUser(21);
      await service.save(user, [{ productId: 'a', quantity: 1 }]);
      await backdate(user, hoursAgo(5));
      expect(await service.stopReminders('x'.repeat(43))).toBe(false);
      expect((await due(user)).length).toBe(1);
      expect(await service.stopReminders((await service.optoutTokenOf(user)) ?? '')).toBe(true);
      expect(await due(user)).toEqual([]);
    });
  });

  it('knows the names of products that are for sale and nothing else', async () => {
    expect(await service.namesOf([])).toEqual(new Map());
    expect(await service.namesOf([`missing-${tag}`])).toEqual(new Map());
  });

  it('the database itself refuses a cart that is not a list', async () => {
    const user = await makeUser(22);
    await service.save(user, []);
    await expect(db.execute(sql`UPDATE shop_carts SET lines = '{"a":1}'::jsonb WHERE user_id = ${user}::uuid`)).rejects.toThrow();
  });
});
