import { createHash, randomUUID } from 'node:crypto';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import type { MediaVisibility } from '@/server/db/drizzle/schema';
import type {
  MediaObjectRef,
  MediaStoragePort,
  MediaVariant,
  StoredMediaProvider,
} from '@/server/ports/media';
import type { MediaAssetView, ProductMediaInput, ProductMediaItem } from '@/types/index';

export type { MediaAssetView };
import { MediaConfigError, MediaError } from './errors';
import {
  ensureExternalAssets,
  getProductGallery,
  setProductGallery,
  type DbOrTx,
} from './product-gallery';
import { MediaRepository, type MediaAssetRow } from './repository';
import { maxImageBytes, parseExternalUrl, sniffImage } from './validation';

/** Finds the adapter for a provider. Assets keep working after the active provider changes. */
export interface MediaPortResolver {
  /** The provider new uploads go to. Throws a configuration error if none is usable. */
  active(): MediaStoragePort;
  /** The adapter that holds an existing asset. */
  forProvider(provider: StoredMediaProvider): MediaStoragePort;
}

export interface MediaActor {
  id: string | null;
  email: string;
}

export interface UploadImageInput {
  data: Buffer;
  originalName: string;
  purpose?: string;
  visibility?: MediaVisibility;
  altText?: string;
  actor: MediaActor;
}

export interface MediaPage {
  items: MediaAssetView[];
  /** Pass back as `before` for the next page; null when this was the last. */
  nextBefore: string | null;
}

export interface PurgeResult {
  stalePendingRemoved: number;
  expiredDeletedRemoved: number;
  failed: number;
}

const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const DELETED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DISCARDED_RETRY_MS = 60 * 60 * 1000;
const PURPOSE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export { MediaConfigError, MediaError };

/** The provider handle for a stored (non-external) asset; the DB check constraint guarantees it exists. */
function storageRef(asset: MediaAssetRow): MediaObjectRef {
  if (asset.storageKey === null) throw new Error(`Media asset ${asset.id} has no storage key.`);
  return { storageKey: asset.storageKey, visibility: asset.visibility, mime: asset.mime };
}

function newId(): string {
  return `media_${randomUUID()}`;
}

export class MediaService {
  readonly repo: MediaRepository;

  constructor(
    private readonly db: DrizzleDb,
    private readonly ports: MediaPortResolver,
  ) {
    this.repo = new MediaRepository(db);
  }

  /**
   * Whether uploads can work right now: the configured storage provider builds without
   * error. Never touches the network, so it is cheap enough for a health probe.
   */
  uploadsReady(): boolean {
    try {
      this.ports.active();
      return true;
    } catch {
      return false;
    }
  }

  // ── Intake ────────────────────────────────────────────────────────────────

  async uploadImage(input: UploadImageInput): Promise<{ asset: MediaAssetView; deduplicated: boolean }> {
    const purpose = input.purpose ?? 'product';
    if (!PURPOSE_PATTERN.test(purpose)) throw new MediaError('Invalid media purpose.');
    const visibility = input.visibility ?? 'public';

    if (input.data.byteLength === 0) throw new MediaError('The file is empty.');
    if (input.data.byteLength > maxImageBytes()) {
      throw new MediaError(`Image must be ${Math.round(maxImageBytes() / (1024 * 1024))} MB or smaller.`);
    }
    const sniffed = sniffImage(input.data);
    if (!sniffed) throw new MediaError('Only JPEG, PNG, WebP, GIF or AVIF images are accepted.');

    const sha256 = createHash('sha256').update(input.data).digest('hex');
    const existing = await this.repo.findByHash(sha256, purpose, visibility, input.actor.id);
    if (existing) return { asset: this.toView(existing), deduplicated: true };

    const port = this.ports.active();
    const stored = await port.put({ data: input.data, mime: sniffed.mime, folder: purpose, visibility });

    try {
      const row = await this.repo.insert({
        id: newId(),
        provider: port.provider,
        visibility,
        resourceType: 'image',
        purpose,
        storageKey: stored.storageKey,
        mime: sniffed.mime,
        bytes: stored.bytes,
        width: stored.width ?? sniffed.width ?? null,
        height: stored.height ?? sniffed.height ?? null,
        sha256,
        originalName: input.originalName.slice(0, 255),
        altText: (input.altText ?? '').trim().slice(0, 300),
        status: 'pending',
        createdBy: input.actor.id,
        createdByEmail: input.actor.email,
      });
      return { asset: this.toView(row), deduplicated: false };
    } catch (error) {
      // Don't leave an object in the provider that no row points to.
      await port.delete({ storageKey: stored.storageKey, visibility }).catch(() => undefined);
      throw error;
    }
  }

  /** A pasted link. Nothing is stored; it joins the library like any other asset. */
  async registerExternalImage(input: {
    url: string;
    altText?: string;
    purpose?: string;
    actor: MediaActor;
  }): Promise<{ asset: MediaAssetView; deduplicated: boolean }> {
    const url = parseExternalUrl(input.url);
    if (url === null) throw new MediaError('Enter a valid image link starting with https:// (or http://).');
    const purpose = input.purpose ?? 'product';
    if (!PURPOSE_PATTERN.test(purpose)) throw new MediaError('Invalid media purpose.');

    const existing = await this.repo.findExternalByUrl(url);
    if (existing) return { asset: this.toView(existing), deduplicated: true };

    const row = await this.repo.insert({
      id: newId(),
      provider: 'external',
      visibility: 'public',
      resourceType: 'image',
      purpose,
      sourceUrl: url,
      altText: (input.altText ?? '').trim().slice(0, 300),
      status: 'pending',
      createdBy: input.actor.id,
      createdByEmail: input.actor.email,
    });
    return { asset: this.toView(row), deduplicated: false };
  }

  // ── Library ───────────────────────────────────────────────────────────────

  async list(filter: { query?: string; purpose?: string; limit?: number; before?: string }): Promise<MediaPage> {
    const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 24), 1), 60);
    const rows = await this.repo.list({ ...filter, limit });
    return {
      items: rows.map((row) => this.toView(row)),
      nextBefore: rows.length === limit ? rows[rows.length - 1].createdAt.toISOString() : null,
    };
  }

  async get(id: string): Promise<MediaAssetView | null> {
    const row = await this.repo.getById(id);
    return row ? this.toView(row) : null;
  }

  async getMany(ids: string[]): Promise<MediaAssetView[]> {
    const rows = await this.repo.getByIds(ids);
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [this.toView(row)] : [];
    });
  }

  async updateAltText(id: string, altText: string): Promise<MediaAssetView> {
    const row = await this.repo.update(id, { altText: altText.trim().slice(0, 300) });
    if (!row) throw new MediaError('Media not found.');
    return this.toView(row);
  }

  /** Marks assets as attached to something so they appear in the library and escape the sweep. */
  async markReady(ids: string[]): Promise<void> {
    for (const id of ids) await this.repo.update(id, { status: 'ready' });
  }

  /**
   * Deletes an asset from the library and removes its file, unless a live product
   * uses it (then it must be removed from those products first). If an order line
   * still shows the image, the file is kept for the history and only the library
   * entry goes.
   */
  async deleteAsset(id: string): Promise<'removed' | 'kept-for-orders'> {
    const row = await this.repo.getById(id);
    if (!row) throw new MediaError('Media not found.');

    const keepFile = await this.repo.isSnapshottedByOrder(this.deliveryUrl(row));
    const outcome = await this.repo.softDeleteIfUnused(id);
    if (outcome.status === 'missing') throw new MediaError('Media not found.');
    if (outcome.status === 'in-use') {
      throw new MediaError(
        `This image is used by ${outcome.uses} product${outcome.uses === 1 ? '' : 's'}. Remove it from them first.`,
      );
    }
    if (keepFile) return 'kept-for-orders';
    await this.removeStored(row);
    return 'removed';
  }

  /**
   * Throws away an upload that was never attached to a product (the admin removed it
   * from the form, or cancelled it). Removes the file right away rather than waiting
   * for the sweep. A safe no-op for anything else: library images, other people's
   * uploads, anything a product already uses.
   */
  async discardUpload(id: string, actor: MediaActor): Promise<boolean> {
    if (actor.id === null) return false;
    const row = await this.repo.softDeleteUnattachedUpload(id, actor.id);
    if (!row) return false;
    return await this.removeStored(row);
  }

  /**
   * Removes the stored file, then the row. The row is already hidden by now; if the
   * provider call fails it stays so the sweep can retry, and the failure is logged.
   */
  private async removeStored(row: MediaAssetRow): Promise<boolean> {
    try {
      if (row.provider !== 'external') {
        await this.ports.forProvider(row.provider).delete(storageRef(row));
      }
      await this.repo.hardDelete(row.id);
      return true;
    } catch (error) {
      console.error(`[media] could not remove the stored file for ${row.id}; the sweep will retry`, error);
      return false;
    }
  }

  // ── Product galleries ─────────────────────────────────────────────────────

  /**
   * Replaces a product's gallery (first item = primary) and refreshes the
   * product's denormalised image columns. Pass the caller's transaction so the
   * gallery commits or rolls back with the product itself.
   */
  setProductGallery(db: DbOrTx, productId: string, items: ProductMediaInput[]) {
    return setProductGallery(db, productId, items, (asset) => this.deliveryUrl(asset));
  }

  getProductGallery(productId: string): Promise<ProductMediaItem[]> {
    return getProductGallery(this.db, productId, (asset) => ({
      url: this.deliveryUrl(asset),
      thumbUrl: this.deliveryUrl(asset, 'thumb'),
    }));
  }

  /** Gallery from plain image links (CSV import): one `external` asset per distinct link. */
  async setProductGalleryFromUrls(db: DbOrTx, productId: string, urls: string[], actorEmail: string) {
    const ids = await ensureExternalAssets(db, urls, actorEmail);
    return await this.setProductGallery(
      db,
      productId,
      ids.map((assetId) => ({ assetId })),
    );
  }

  // ── Delivery ──────────────────────────────────────────────────────────────

  /**
   * The provider URL for an asset, signed when private. This is the only place
   * a private URL is produced: call it only after an access check.
   */
  deliveryUrl(asset: MediaAssetRow, variant: MediaVariant = 'original'): string {
    if (asset.provider === 'external') return asset.sourceUrl ?? '';
    const port = this.ports.forProvider(asset.provider);
    return port.urlFor(storageRef(asset), { variant });
  }

  async deliveryUrlById(id: string, variant: MediaVariant = 'original'): Promise<string | null> {
    const row = await this.repo.getById(id);
    return row ? this.deliveryUrl(row, variant) : null;
  }

  // ── Housekeeping ──────────────────────────────────────────────────────────

  /**
   * Sweeps uploads that were never attached (24 h) and assets deleted from the
   * library long enough ago (30 d) — except files an order line still points at.
   * Provider failures leave the row in place to retry on the next run.
   */
  async purge(now = new Date(), batch = 100): Promise<PurgeResult> {
    const result: PurgeResult = { stalePendingRemoved: 0, expiredDeletedRemoved: 0, failed: 0 };

    const remove = async (row: MediaAssetRow): Promise<boolean> => {
      try {
        if (row.provider !== 'external') {
          await this.ports.forProvider(row.provider).delete(storageRef(row));
        }
        await this.repo.hardDelete(row.id);
        return true;
      } catch {
        result.failed += 1;
        return false;
      }
    };

    for (const row of await this.repo.listStalePending(new Date(now.getTime() - PENDING_TTL_MS), batch)) {
      if (await remove(row)) result.stalePendingRemoved += 1;
    }
    // Discarded uploads whose file could not be removed at the time: nothing can reference them, retry soon.
    for (const row of await this.repo.listDiscardedUploads(new Date(now.getTime() - DISCARDED_RETRY_MS), batch)) {
      if (await remove(row)) result.stalePendingRemoved += 1;
    }
    for (const row of await this.repo.listExpiredDeleted(new Date(now.getTime() - DELETED_RETENTION_MS), batch)) {
      if (await this.repo.isSnapshottedByOrder(this.deliveryUrl(row))) continue;
      if (await remove(row)) result.expiredDeletedRemoved += 1;
    }
    return result;
  }

  // ── View ──────────────────────────────────────────────────────────────────

  toView(row: MediaAssetRow): MediaAssetView {
    const isPrivate = row.visibility === 'private';
    const url = isPrivate ? `/api/media/${row.id}` : this.deliveryUrl(row);
    const thumbUrl = isPrivate ? `/api/media/${row.id}?variant=thumb` : this.deliveryUrl(row, 'thumb');
    return {
      id: row.id,
      provider: row.provider,
      visibility: row.visibility,
      purpose: row.purpose,
      url,
      thumbUrl,
      mime: row.mime,
      bytes: row.bytes,
      width: row.width,
      height: row.height,
      altText: row.altText,
      originalName: row.originalName,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
