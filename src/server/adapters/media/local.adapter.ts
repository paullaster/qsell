import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  MediaObjectRef,
  MediaStoragePort,
  PutMediaInput,
  PutMediaResult,
} from '@/server/ports/media';

const EXTENSIONS: Partial<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

/** URL prefix of the route that serves local files (`app/api/media/file/[...key]`). */
export const LOCAL_MEDIA_URL_PREFIX = '/api/media/file/';

export function localMediaRoot(): string {
  // A runtime data folder, not source: the build must not trace the whole project for it.
  return path.resolve(
    /*turbopackIgnore: true*/ process.env.MEDIA_LOCAL_DIR ??
      path.join(process.cwd(), 'storage', 'media'),
  );
}

/**
 * Resolves a storage key to a path inside the media root, or null if the key
 * would escape it. The delivery route and delete both go through this.
 */
export function resolveLocalMediaPath(storageKey: string): string | null {
  const root = localMediaRoot();
  const absolute = path.resolve(root, storageKey);
  return absolute.startsWith(root + path.sep) ? absolute : null;
}

/**
 * Writes to local disk. For development and single-node installs only: a
 * container's filesystem is ephemeral, so production should use a real provider.
 * Variants are not generated; `next/image` resizes at request time instead.
 */
export class LocalMediaAdapter implements MediaStoragePort {
  readonly provider = 'local' as const;

  async put(input: PutMediaInput): Promise<PutMediaResult> {
    const extension = EXTENSIONS[input.mime];
    if (extension === undefined) throw new Error(`Unsupported media type: ${input.mime}`);
    const sanitized = input.folder.replace(/[^a-z0-9_-]/gi, '');
    const folder = sanitized === '' ? 'misc' : sanitized;
    const storageKey = `${input.visibility}/${folder}/${randomUUID()}.${extension}`;
    const target = resolveLocalMediaPath(storageKey);
    if (target === null) throw new Error('Invalid storage key');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, input.data, { flag: 'wx' });
    return { storageKey, bytes: input.data.byteLength };
  }

  async delete(ref: MediaObjectRef): Promise<void> {
    const target = resolveLocalMediaPath(ref.storageKey);
    if (target === null) return;
    await rm(target, { force: true });
  }

  urlFor(ref: MediaObjectRef): string {
    return `${LOCAL_MEDIA_URL_PREFIX}${ref.storageKey.split('/').map(encodeURIComponent).join('/')}`;
  }
}
