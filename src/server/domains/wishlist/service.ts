import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { drizzleDb, type DrizzleDb } from '@/server/db/drizzle/client';
import { products, wishlistItems } from '@/server/db/drizzle/schema';
import { WISHLIST_MAX } from '@/lib/wishlist';

/** A signed-in shopper's saved products. Only products that are for sale can be saved; the list is the person's own, by their account id. */
export const WishlistService = {
  async ids(userId: string, db: DrizzleDb = drizzleDb): Promise<string[]> {
    const rows = await db.select({ id: wishlistItems.productId }).from(wishlistItems).where(eq(wishlistItems.userId, userId)).orderBy(desc(wishlistItems.createdAt)).limit(WISHLIST_MAX);
    return rows.map((row) => row.id);
  },

  async set(userId: string, productId: string, on: boolean, db: DrizzleDb = drizzleDb): Promise<void> {
    if (!on) {
      await db.delete(wishlistItems).where(and(eq(wishlistItems.userId, userId), eq(wishlistItems.productId, productId)));
      return;
    }
    await db.transaction(async (tx) => {
      // The list is capped: a person cannot make it grow without bound.
      const [held] = await tx.select({ n: sql<number>`count(*)::int` }).from(wishlistItems).where(eq(wishlistItems.userId, userId));
      if ((held?.n ?? 0) >= WISHLIST_MAX) return;
      const live = await tx.select({ id: products.id }).from(products).where(and(eq(products.id, productId), eq(products.isActive, true), eq(products.isSellable, true), sql`${products.deletedAt} is null`));
      if (live.length === 0) return;
      await tx.insert(wishlistItems).values({ userId, productId }).onConflictDoNothing();
    });
  },

  /** Adds what a guest saved in the browser before signing in. Unknown or withdrawn products are skipped. */
  async merge(userId: string, productIds: string[], db: DrizzleDb = drizzleDb): Promise<string[]> {
    const wanted = [...new Set(productIds)].slice(0, WISHLIST_MAX);
    if (wanted.length > 0) {
      await db.transaction(async (tx) => {
        const live = await tx.select({ id: products.id }).from(products).where(and(inArray(products.id, wanted), eq(products.isActive, true), eq(products.isSellable, true), sql`${products.deletedAt} is null`));
        if (live.length > 0) await tx.insert(wishlistItems).values(live.map((row) => ({ userId, productId: row.id }))).onConflictDoNothing();
      });
    }
    return await WishlistService.ids(userId, db);
  },
};
