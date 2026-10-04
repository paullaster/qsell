import { and, desc, eq, ilike, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { mediaAssets, orderItems, productMedia, products } from '@/server/db/drizzle/schema';

export type MediaAssetRow = typeof mediaAssets.$inferSelect;
export type MediaAssetInsert = typeof mediaAssets.$inferInsert;

export interface MediaListFilter {
  /** Matches file name or alt text. */
  query?: string;
  purpose?: string;
  limit: number;
  /** ISO timestamp of the last row of the previous page. */
  before?: string;
}

export class MediaRepository {
  constructor(private readonly db: DrizzleDb) {}

  async insert(values: MediaAssetInsert): Promise<MediaAssetRow> {
    const [row] = await this.db.insert(mediaAssets).values(values).returning();
    return row;
  }

  async getById(id: string): Promise<MediaAssetRow | null> {
    const rows = await this.db
      .select()
      .from(mediaAssets)
      .where(and(eq(mediaAssets.id, id), isNull(mediaAssets.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  async getByIds(ids: string[]): Promise<MediaAssetRow[]> {
    if (ids.length === 0) return [];
    return await this.db
      .select()
      .from(mediaAssets)
      .where(and(inArray(mediaAssets.id, ids), isNull(mediaAssets.deletedAt)));
  }

  /**
   * Same bytes already stored with the same visibility and purpose — reuse instead of
   * re-uploading. Library ('ready') assets are shared; an unattached upload is only ever
   * reused by the person who made it, so discarding it can't pull it out from under someone else.
   */
  async findByHash(
    sha256: string,
    purpose: string,
    visibility: string,
    actorId: string | null,
  ): Promise<MediaAssetRow | null> {
    const reusable =
      actorId === null
        ? eq(mediaAssets.status, 'ready')
        : or(
            eq(mediaAssets.status, 'ready'),
            and(eq(mediaAssets.status, 'pending'), eq(mediaAssets.createdBy, actorId)),
          );
    const rows = await this.db
      .select()
      .from(mediaAssets)
      .where(
        and(
          eq(mediaAssets.sha256, sha256),
          eq(mediaAssets.purpose, purpose),
          eq(mediaAssets.visibility, visibility as 'public' | 'private'),
          isNotNull(mediaAssets.storageKey),
          isNull(mediaAssets.deletedAt),
          reusable,
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async findExternalByUrl(url: string): Promise<MediaAssetRow | null> {
    const rows = await this.db
      .select()
      .from(mediaAssets)
      .where(
        and(
          eq(mediaAssets.provider, 'external'),
          eq(mediaAssets.sourceUrl, url),
          isNull(mediaAssets.deletedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** The shared library: attached ('ready') assets only, newest first. */
  async list(filter: MediaListFilter): Promise<MediaAssetRow[]> {
    const conditions = [eq(mediaAssets.status, 'ready'), isNull(mediaAssets.deletedAt)];
    if (filter.purpose !== undefined && filter.purpose !== '') conditions.push(eq(mediaAssets.purpose, filter.purpose));
    if (filter.before !== undefined && filter.before !== '') conditions.push(lt(mediaAssets.createdAt, new Date(filter.before)));
    const query = filter.query?.trim();
    if (query !== undefined && query !== '') {
      const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
      const match = or(ilike(mediaAssets.originalName, pattern), ilike(mediaAssets.altText, pattern));
      if (match) conditions.push(match);
    }
    return await this.db
      .select()
      .from(mediaAssets)
      .where(and(...conditions))
      .orderBy(desc(mediaAssets.createdAt))
      .limit(filter.limit);
  }

  async update(id: string, patch: Partial<MediaAssetInsert>): Promise<MediaAssetRow | null> {
    const rows = await this.db
      .update(mediaAssets)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(mediaAssets.id, id), isNull(mediaAssets.deletedAt)))
      .returning();
    return rows.at(0) ?? null;
  }

  /**
   * Hides an asset from the library unless a live product uses it. The asset row is
   * locked for the check, and attaching an image takes a shared lock on it, so a
   * delete and a concurrent attach cannot both succeed.
   */
  async softDeleteIfUnused(
    id: string,
  ): Promise<{ status: 'deleted' } | { status: 'in-use'; uses: number } | { status: 'missing' }> {
    return await this.db.transaction(async (tx) => {
      const locked = (
        await tx
          .select({ id: mediaAssets.id })
          .from(mediaAssets)
          .where(and(eq(mediaAssets.id, id), isNull(mediaAssets.deletedAt)))
          .for('update')
          .limit(1)
      ).at(0);
      if (locked === undefined) return { status: 'missing' as const };

      const usage = await tx
        .select({ value: sql<number>`count(*)::int` })
        .from(productMedia)
        .innerJoin(products, eq(products.id, productMedia.productId))
        .where(and(eq(productMedia.assetId, id), isNull(products.deletedAt)));
      const uses = usage.at(0)?.value ?? 0;
      if (uses > 0) return { status: 'in-use' as const, uses };

      // Links left by deleted products no longer count, but would block removing the row.
      await tx
        .delete(productMedia)
        .where(
          and(
            eq(productMedia.assetId, id),
            inArray(
              productMedia.productId,
              tx.select({ id: products.id }).from(products).where(isNotNull(products.deletedAt)),
            ),
          ),
        );
      await tx
        .update(mediaAssets)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(mediaAssets.id, id));
      return { status: 'deleted' as const };
    });
  }

  /** Hides an upload that was never attached to anything, but only for the person who made it. */
  async softDeleteUnattachedUpload(id: string, ownerId: string): Promise<MediaAssetRow | null> {
    return await this.db.transaction(async (tx) => {
      const locked = (
        await tx
          .select()
          .from(mediaAssets)
          .where(and(eq(mediaAssets.id, id), isNull(mediaAssets.deletedAt)))
          .for('update')
          .limit(1)
      ).at(0);
      if (locked?.status !== 'pending' || locked.createdBy !== ownerId) return null;

      const links = await tx
        .select({ value: sql<number>`count(*)::int` })
        .from(productMedia)
        .where(eq(productMedia.assetId, id));
      if ((links.at(0)?.value ?? 0) > 0) return null;

      await tx
        .update(mediaAssets)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(mediaAssets.id, id));
      return locked;
    });
  }

  async hardDelete(id: string): Promise<void> {
    await this.db.delete(mediaAssets).where(eq(mediaAssets.id, id));
  }

  /** Uploaded but never attached to anything, older than the cutoff. */
  async listStalePending(cutoff: Date, limit: number): Promise<MediaAssetRow[]> {
    return await this.db
      .select()
      .from(mediaAssets)
      .where(
        and(
          eq(mediaAssets.status, 'pending'),
          isNull(mediaAssets.deletedAt),
          lt(mediaAssets.createdAt, cutoff),
          sql`not exists (select 1 from ${productMedia} where ${productMedia.assetId} = ${mediaAssets.id})`,
        ),
      )
      .limit(limit);
  }

  /** Uploads thrown away before ever being attached whose file removal failed and needs a retry. */
  async listDiscardedUploads(cutoff: Date, limit: number): Promise<MediaAssetRow[]> {
    return await this.db
      .select()
      .from(mediaAssets)
      .where(
        and(
          eq(mediaAssets.status, 'pending'),
          isNotNull(mediaAssets.deletedAt),
          lt(mediaAssets.deletedAt, cutoff),
          sql`not exists (select 1 from ${productMedia} where ${productMedia.assetId} = ${mediaAssets.id})`,
        ),
      )
      .limit(limit);
  }

  /** Soft-deleted before the cutoff and with no product reference left. */
  async listExpiredDeleted(cutoff: Date, limit: number): Promise<MediaAssetRow[]> {
    return await this.db
      .select()
      .from(mediaAssets)
      .where(
        and(
          isNotNull(mediaAssets.deletedAt),
          lt(mediaAssets.deletedAt, cutoff),
          sql`not exists (select 1 from ${productMedia} where ${productMedia.assetId} = ${mediaAssets.id})`,
        ),
      )
      .limit(limit);
  }

  /** Order lines snapshot the image URL; a file a customer once bought against must stay. */
  async isSnapshottedByOrder(url: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: orderItems.id })
      .from(orderItems)
      .where(eq(orderItems.imageUrl, url))
      .limit(1);
    return rows.length > 0;
  }
}
