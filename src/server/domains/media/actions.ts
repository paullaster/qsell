'use server';

import { auth } from '@/auth';
import { requirePermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { MediaError, type MediaActor, type MediaAssetView, type MediaPage } from './service';

/**
 * Result objects, not thrown errors: Next redacts thrown messages in production,
 * and "this image is used by 3 products" is something the admin must be able to read.
 */
export type MediaResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function actorFor(userId: string): Promise<MediaActor> {
  const session = await auth();
  return { id: userId, email: session?.user.email ?? '' };
}

async function run<T>(work: () => Promise<T>): Promise<MediaResult<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (error) {
    if (error instanceof MediaError) return { ok: false, error: error.message };
    throw error;
  }
}

export async function listMediaAction(filter: {
  query?: string;
  purpose?: string;
  limit?: number;
  before?: string;
}): Promise<MediaPage> {
  await requirePermission('media:read');
  return getContainer().media.list(filter);
}

export async function registerExternalMediaAction(input: {
  url: string;
  altText?: string;
  purpose?: string;
}): Promise<MediaResult<{ asset: MediaAssetView; deduplicated: boolean }>> {
  const userId = await requirePermission('media:upload');
  const actor = await actorFor(userId);
  return run(() => getContainer().media.registerExternalImage({ ...input, actor }));
}

export async function updateMediaAltTextAction(
  id: string,
  altText: string,
): Promise<MediaResult<MediaAssetView>> {
  await requirePermission('media:upload');
  return run(() => getContainer().media.updateAltText(id, altText));
}

/** 'kept-for-orders': gone from the library, but the file stays because an order still shows it. */
export async function deleteMediaAction(
  id: string,
): Promise<MediaResult<{ outcome: 'removed' | 'kept-for-orders' }>> {
  await requirePermission('media:delete');
  return run(async () => ({ outcome: await getContainer().media.deleteAsset(id) }));
}

/**
 * Throws away uploads that never got attached to a product (removed from the form, or
 * the form was cancelled) and deletes their files immediately. Takes a batch so closing
 * a form is a single request that cannot be half-cancelled by the page navigating away.
 * Safe to call with any ids: each one is skipped unless it is the caller's own
 * unattached upload.
 */
export async function discardMediaUploadsAction(ids: string[]): Promise<MediaResult<{ removed: number }>> {
  const userId = await requirePermission('media:upload');
  const actor = await actorFor(userId);
  return run(async () => {
    let removed = 0;
    for (const id of ids.slice(0, 50)) {
      if (await getContainer().media.discardUpload(id, actor)) removed += 1;
    }
    return { removed };
  });
}
