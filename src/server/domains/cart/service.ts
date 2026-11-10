import { randomBytes } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzleDb, type DrizzleDb } from '@/server/db/drizzle/client';
import { products, shopCarts } from '@/server/db/drizzle/schema';
import { cleanCartLines, mergeCartLines, REMINDER_GAP_DAYS, REMINDER_IDLE_MINUTES, REMINDER_MAX_AGE_DAYS, sameCartLines, type ServerCartLine } from '@/lib/shop-cart';

const newToken = (): string => randomBytes(32).toString('base64url');

export interface ReminderCandidate {
  userId: string;
  updatedAt: Date;
}

/** A signed-in shopper's cart on the server: ids and quantities, one row per shopper, always the shopper's own (by account id). */
export const ShopCartService = {
  async get(userId: string, db: DrizzleDb = drizzleDb): Promise<ServerCartLine[]> {
    const [row] = await db.select({ lines: shopCarts.lines }).from(shopCarts).where(eq(shopCarts.userId, userId));
    return cleanCartLines(row?.lines);
  },

  /**
   * Replaces the cart. The server stamps the time, and only when the lines really changed, so a page that saves the same cart
   * again does not start the idle clock over. A changed cart can be reminded about again.
   */
  async save(userId: string, lines: unknown, db: DrizzleDb = drizzleDb): Promise<ServerCartLine[]> {
    const next = cleanCartLines(lines);
    return await db.transaction(async (tx) => {
      await tx.insert(shopCarts).values({ userId, lines: [], optoutToken: newToken() }).onConflictDoNothing();
      const [row] = await tx.select({ lines: shopCarts.lines }).from(shopCarts).where(eq(shopCarts.userId, userId)).for('update');
      if (!sameCartLines(cleanCartLines(row?.lines), next)) {
        await tx.update(shopCarts).set({ lines: next, updatedAt: sql`now()` }).where(eq(shopCarts.userId, userId));
      }
      return next;
    });
  },

  /** After signing in: what was carried in the browser joins the account's cart. Returns the cart now. */
  async merge(userId: string, browserLines: unknown, db: DrizzleDb = drizzleDb): Promise<ServerCartLine[]> {
    const account = await ShopCartService.get(userId, db);
    return await ShopCartService.save(userId, mergeCartLines(account, cleanCartLines(browserLines)), db);
  },

  async clear(userId: string, db: DrizzleDb = drizzleDb): Promise<void> {
    await db.update(shopCarts).set({ lines: [], updatedAt: sql`now()` }).where(and(eq(shopCarts.userId, userId), sql`${shopCarts.lines} <> '[]'::jsonb`));
  },

  /** The shopper's choice to stop (or start again) hearing about a cart they left. */
  async stopReminders(token: string, db: DrizzleDb = drizzleDb): Promise<boolean> {
    const rows = await db.update(shopCarts).set({ remindersOff: true }).where(eq(shopCarts.optoutToken, token)).returning({ userId: shopCarts.userId });
    return rows.length > 0;
  },

  async optoutTokenOf(userId: string, db: DrizzleDb = drizzleDb): Promise<string | null> {
    const [row] = await db.select({ token: shopCarts.optoutToken }).from(shopCarts).where(eq(shopCarts.userId, userId));
    return row?.token ?? null;
  },

  /**
   * Carts left behind: something in them, unchanged for the idle time but not older than the limit, not yet reminded for this state, not
   * reminded within the gap, the shopper has not stopped them, their account is in good standing, and they have not ordered since.
   * An order is matched by the account id and by the customer id the shop records on the order.
   */
  async abandoned(now: Date, limit: number, db: DrizzleDb = drizzleDb, onlyUser?: string): Promise<ReminderCandidate[]> {
    const idleBefore = new Date(now.getTime() - REMINDER_IDLE_MINUTES * 60_000);
    const notOlderThan = new Date(now.getTime() - REMINDER_MAX_AGE_DAYS * 86_400_000);
    const gapBefore = new Date(now.getTime() - REMINDER_GAP_DAYS * 86_400_000);
    const result = await db.execute<{ user_id: string; updated_at: Date }>(sql`
      SELECT c.user_id, c.updated_at
      FROM shop_carts c
      JOIN users u ON u.id = c.user_id
      WHERE c.reminders_off = false
        ${onlyUser === undefined ? sql`` : sql`AND c.user_id = ${onlyUser}::uuid`}
        AND c.lines <> '[]'::jsonb
        AND c.updated_at <= ${idleBefore.toISOString()}::timestamptz
        AND c.updated_at > ${notOlderThan.toISOString()}::timestamptz
        AND (c.reminded_at IS NULL OR (c.reminded_at < c.updated_at AND c.reminded_at <= ${gapBefore.toISOString()}::timestamptz))
        AND u.role = 'customer' AND u.is_active = true AND u.status = 'active' AND u.email_verified_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM orders o
          WHERE o.created_at > c.updated_at
            AND (o.user_id = c.user_id::text OR (u.customer_store_id IS NOT NULL AND o.user_id = u.customer_store_id))
        )
      ORDER BY c.updated_at
      LIMIT ${limit}`);
    return result.map((row) => ({ userId: row.user_id, updatedAt: new Date(row.updated_at) }));
  },

  /** Marks the reminder as sent, only if the cart is still as it was when the reminder was decided. */
  async markReminded(userId: string, updatedAt: Date, now: Date, db: DrizzleDb = drizzleDb): Promise<boolean> {
    const rows = await db.update(shopCarts).set({ remindedAt: now }).where(and(eq(shopCarts.userId, userId), sql`${shopCarts.updatedAt} >= ${updatedAt.toISOString()}::timestamptz AND ${shopCarts.updatedAt} < ${updatedAt.toISOString()}::timestamptz + interval '1 millisecond'`)).returning({ userId: shopCarts.userId });
    return rows.length > 0;
  },

  /** What is for sale among these ids, with their names, in the order given. */
  async namesOf(ids: readonly string[], db: DrizzleDb = drizzleDb): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await db.select({ id: products.id, name: products.name }).from(products).where(and(inArray(products.id, [...ids]), eq(products.isActive, true), eq(products.isSellable, true), eq(products.showOnWebShop, true), sql`${products.deletedAt} is null`));
    return new Map(rows.map((row) => [row.id, row.name]));
  },
};
