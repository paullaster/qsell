import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { mediaAssets, productMedia, products } from '@/server/db/drizzle/schema';
import type { ProductMediaInput, ProductMediaItem } from '@/types/index';
import type { MediaAssetRow } from './repository';
import { MAX_PRODUCT_MEDIA } from '@/lib/media';
import { MediaError } from './errors';
import { parseExternalUrl } from './validation';

/** A database handle or a transaction: callers pass their own `tx` so gallery changes commit with the product. */
export type DbOrTx = Pick<DrizzleDb, 'select' | 'insert' | 'update' | 'delete'>;

export { MAX_PRODUCT_MEDIA };

/** Resolves an asset to the public URL stored on the product (supplied by the service, which owns the ports). */
export type AssetUrlResolver = (asset: MediaAssetRow) => string;

/**
 * Replaces a product's gallery. The first item is the primary image. Also
 * refreshes `products.image_url` / `additional_images`, the denormalised copy the
 * storefront, orders and CSV read, so the two can never disagree after a save.
 */
export async function setProductGallery(
  db: DbOrTx,
  productId: string,
  input: ProductMediaInput[],
  urlOf: AssetUrlResolver,
): Promise<{ imageUrl: string; additionalImages: string[] }> {
  const items: ProductMediaInput[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (seen.has(item.assetId)) continue;
    seen.add(item.assetId);
    items.push(item);
  }
  if (items.length > MAX_PRODUCT_MEDIA) {
    throw new MediaError(`A product can have at most ${MAX_PRODUCT_MEDIA} images.`);
  }

  const ids = items.map((item) => item.assetId);
  const assets =
    ids.length === 0
      ? []
      : await db
          .select()
          .from(mediaAssets)
          .where(and(inArray(mediaAssets.id, ids), isNull(mediaAssets.deletedAt)))
          // Shared row lock: a delete of one of these assets (which takes an exclusive lock) waits for this save.
          .for('share');
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  if (byId.size !== ids.length) {
    throw new MediaError('One of the selected images is no longer available. Remove it and try again.');
  }
  if (assets.some((asset) => asset.visibility === 'private')) {
    throw new MediaError('Private files cannot be used as product images.');
  }

  await db.delete(productMedia).where(eq(productMedia.productId, productId));
  if (items.length > 0) {
    await db.insert(productMedia).values(
      items.map((item, position) => {
        const altText = item.altText?.trim() ?? '';
        return {
          productId,
          assetId: item.assetId,
          position,
          isPrimary: position === 0,
          altText: altText !== '' ? altText.slice(0, 300) : null,
        };
      }),
    );
    // Attached assets leave the 'pending' state and are safe from the unattached-upload sweep.
    await db
      .update(mediaAssets)
      .set({ status: 'ready', updatedAt: new Date() })
      .where(and(inArray(mediaAssets.id, ids), eq(mediaAssets.status, 'pending')));
  }

  const urls = items.flatMap((item) => {
    const asset = byId.get(item.assetId);
    return asset ? [urlOf(asset)] : [];
  });
  const imageUrl = urls[0] ?? '';
  const additionalImages = urls.slice(1);
  await db
    .update(products)
    .set({ imageUrl, additionalImages, updatedAt: new Date() })
    .where(eq(products.id, productId));
  return { imageUrl, additionalImages };
}

/**
 * The gallery as read back for the product form. The first slot is always the
 * primary, even for legacy rows that were backfilled without one.
 */
export async function getProductGallery(
  db: DbOrTx,
  productId: string,
  toItem: (asset: MediaAssetRow) => { url: string; thumbUrl: string },
): Promise<ProductMediaItem[]> {
  const rows = await db
    .select({ link: productMedia, asset: mediaAssets })
    .from(productMedia)
    .innerJoin(mediaAssets, eq(productMedia.assetId, mediaAssets.id))
    .where(and(eq(productMedia.productId, productId), isNull(mediaAssets.deletedAt)))
    .orderBy(asc(productMedia.position), asc(productMedia.createdAt));
  return rows.map(({ link, asset }, index) => {
    const { url, thumbUrl } = toItem(asset);
    const override = link.altText?.trim() ?? '';
    return {
      assetId: asset.id,
      url,
      thumbUrl,
      altText: override !== '' ? override : asset.altText,
      originalName: asset.originalName,
      provider: asset.provider,
      width: asset.width,
      height: asset.height,
      isPrimary: index === 0,
    };
  });
}

/**
 * Asset ids for a list of image links, creating `external` assets as needed
 * (de-duplicated by URL). Invalid links are skipped. Used by CSV import.
 */
export async function ensureExternalAssets(
  db: DbOrTx,
  urls: string[],
  actorEmail: string,
): Promise<string[]> {
  const unique = [...new Set(urls.map(parseExternalUrl).filter((url): url is string => url !== null))];
  if (unique.length === 0) return [];

  const find = () =>
    db
      .select({ id: mediaAssets.id, sourceUrl: mediaAssets.sourceUrl })
      .from(mediaAssets)
      .where(
        and(
          eq(mediaAssets.provider, 'external'),
          inArray(mediaAssets.sourceUrl, unique),
          isNull(mediaAssets.deletedAt),
        ),
      );

  const known = new Map((await find()).map((row) => [row.sourceUrl, row.id]));
  const missing = unique.filter((url) => !known.has(url));
  if (missing.length > 0) {
    await db
      .insert(mediaAssets)
      .values(
        missing.map((sourceUrl) => ({
          id: `media_${randomUUID()}`,
          provider: 'external' as const,
          visibility: 'public' as const,
          resourceType: 'image',
          purpose: 'product',
          sourceUrl,
          status: 'pending' as const,
          createdByEmail: actorEmail,
        })),
      )
      .onConflictDoNothing();
    for (const row of await find()) known.set(row.sourceUrl, row.id);
  }
  return unique.flatMap((url) => {
    const id = known.get(url);
    return id !== undefined ? [id] : [];
  });
}
