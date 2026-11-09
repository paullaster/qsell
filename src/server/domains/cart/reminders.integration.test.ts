import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { has } from '@/lib/values';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import type { ShopCartService as Cart } from './service';
import type * as Reminders from './reminders';

/** The reminder about a left cart, end to end through a real database and a stand-in mail sender.   TEST_DATABASE_URL=postgres://... pnpm test */
const url = process.env.TEST_DATABASE_URL;
const sent: { to: string; subject: string; html: string; text: string }[] = [];
let failSending = false;

vi.mock('@/server/di/container', () => ({
  getContainer: () => ({
    companySettings: { ensureSeeded: () => Promise.resolve({ tradingName: 'Acme Shop', publicBaseUrl: 'https://shop.example.test' }) },
    email: {
      send: (message: { to: string; subject: string; html: string; text: string }) => {
        if (failSending) return Promise.reject(new Error('mail server down'));
        sent.push(message);
        return Promise.resolve();
      },
    },
  }),
}));

describe.skipIf(!has(url))('cart reminder (database)', () => {
  let cart: typeof Cart;
  let db: DrizzleDb;
  let reminders: typeof Reminders;
  const tag = randomUUID().slice(0, 6);
  const now = new Date();
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
  const product = (n: number) => `rp-${tag}-${String(n)}`;

  const shopper = async (n: number, email?: string): Promise<string> => {
    const id = randomUUID();
    await db.execute(sql`INSERT INTO users (id, email, password_hash, name, role, email_verified_at) VALUES (${id}::uuid, ${email ?? `r${String(n)}-${tag}@example.test`}, 'x', 'Wanjiru Kamau', 'customer', now())`);
    return id;
  };
  const leave = async (userId: string, lines: { productId: string; quantity: number }[]) => {
    await cart.save(userId, lines);
    await db.execute(sql`UPDATE shop_carts SET updated_at = ${hoursAgo(5).toISOString()}::timestamptz WHERE user_id = ${userId}::uuid`);
    const [row] = (await cart.abandoned(now, 500, db)).filter((c) => c.userId === userId);
    return row?.updatedAt ?? now;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    ({ ShopCartService: cart } = await import('./service'));
    ({ drizzleDb: db } = await import('@/server/db/drizzle/client'));
    reminders = await import('./reminders');
    await db.execute(sql`INSERT INTO item_types (id, code, name) VALUES (${`it-${tag}`}, ${Date.now() % 2_000_000_000}, ${`Test type ${tag}`})`);
    for (const [n, name] of [[1, 'Steel Kettle'], [2, 'Tea <b>Cups</b>']] as const) {
      await db.execute(sql`INSERT INTO products (id, sku, name, slug, item_type_id, stock_code, is_active, is_sellable) VALUES (${product(n)}, ${`SKU-${tag}-${String(n)}`}, ${name}, ${`slug-${tag}-${String(n)}`}, ${`it-${tag}`}, ${`SC-${tag}-${String(n)}`}, true, true)`);
    }
  });
  beforeEach(() => {
    sent.length = 0;
    failSending = false;
  });

  it('writes to the shopper about what they left, with a way to stop, and records that it did', async () => {
    const user = await shopper(1);
    const at = await leave(user, [{ productId: product(1), quantity: 2 }, { productId: product(2), quantity: 1 }]);
    expect(await reminders.sendCartReminder(user, at, now)).toBe('sent');
    expect(sent).toHaveLength(1);
    const mail = sent[0];
    expect(mail?.to).toBe(`r1-${tag}@example.test`);
    expect(mail?.subject).toContain('Acme Shop');
    expect(mail?.text).toContain('Steel Kettle');
    expect(mail?.text).toContain('https://shop.example.test/checkout');
    const token = await cart.optoutTokenOf(user);
    expect(mail?.text).toContain(`/cart/reminders-off?token=${token ?? ''}`);
    // Names are escaped, never run as markup.
    expect(mail?.html).not.toContain('<b>Cups</b>');
    // And it is not sent a second time.
    expect(await reminders.sendCartReminder(user, at, now)).toBe('not_due');
    expect(sent).toHaveLength(1);
  });

  it('records nothing when the mail server is down, so the retry sends it', async () => {
    const user = await shopper(2);
    const at = await leave(user, [{ productId: product(1), quantity: 1 }]);
    failSending = true;
    await expect(reminders.sendCartReminder(user, at, now)).rejects.toThrow('mail server down');
    failSending = false;
    expect(await reminders.sendCartReminder(user, at, now)).toBe('sent');
    expect(sent).toHaveLength(1);
  });

  it('sends nothing when the cart changed after the reminder was queued', async () => {
    const user = await shopper(3);
    const at = await leave(user, [{ productId: product(1), quantity: 1 }]);
    await cart.save(user, [{ productId: product(1), quantity: 3 }]);
    expect(await reminders.sendCartReminder(user, at, now)).toBe('not_due');
    expect(sent).toHaveLength(0);
  });

  it('settles a cart whose products are no longer for sale, so it is not queued again', async () => {
    const user = await shopper(4);
    const at = await leave(user, [{ productId: `gone-${tag}`, quantity: 1 }]);
    expect(await reminders.sendCartReminder(user, at, now)).toBe('nothing_to_show');
    expect(await cart.abandoned(now, 500, db, user)).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it('settles a cart whose owner has no usable address', async () => {
    const user = await shopper(5, `not-an-address-${tag}`);
    const at = await leave(user, [{ productId: product(1), quantity: 1 }]);
    expect(await reminders.sendCartReminder(user, at, now)).toBe('no_address');
    expect(await cart.abandoned(now, 500, db, user)).toEqual([]);
  });

  it('the sweep finds the due carts', async () => {
    const user = await shopper(6);
    await leave(user, [{ productId: product(1), quantity: 1 }]);
    const found = await reminders.dueCartReminders(new Date());
    expect(found.map((c) => c.userId)).toContain(user);
  });
});
