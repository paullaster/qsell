import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { canReadMedia } from '@/server/domains/media/access';
import { resolveLocalMediaPath } from '@/server/adapters/media/local.adapter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MIME_TYPES: Partial<Record<string, string>> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
};

/**
 * Serves files written by the local storage adapter. `public/…` keys are open;
 * `private/…` keys need a signed-in user who can read the media library.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ key: string[] }> },
) {
  const { key } = await params;
  const storageKey = key.join('/');
  const isPrivate = storageKey.startsWith('private/');
  if (!isPrivate && !storageKey.startsWith('public/')) {
    return new Response('Not found', { status: 404 });
  }
  if (isPrivate) {
    if (!(await canReadMedia())) return new Response('Not found', { status: 404 });
  }

  const absolute = resolveLocalMediaPath(storageKey);
  const mime = MIME_TYPES[path.extname(storageKey).slice(1).toLowerCase()];
  if (absolute === null || mime === undefined) return new Response('Not found', { status: 404 });

  try {
    const bytes = await readFile(absolute);
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': mime,
        'Content-Length': String(bytes.byteLength),
        // Keys are random and never reused, so a public file is immutable.
        'Cache-Control': isPrivate ? 'private, no-store' : 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
