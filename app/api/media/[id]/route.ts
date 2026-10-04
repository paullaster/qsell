import { NextResponse } from 'next/server';
import { getContainer } from '@/server/di/container';
import { canReadMedia } from '@/server/domains/media/access';
import type { MediaVariant } from '@/server/ports/media';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VARIANTS = new Set<MediaVariant>(['original', 'thumb', 'card', 'detail']);

/**
 * The authorised front door for private media. Provider URLs for private assets
 * are signed and only ever produced here, after the access check; they are
 * never stored or sent to the client in a page payload.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await canReadMedia())) return new Response('Not found', { status: 404 });

  const requested = new URL(request.url).searchParams.get('variant') as MediaVariant | null;
  const variant: MediaVariant = requested !== null && VARIANTS.has(requested) ? requested : 'original';

  const url = await getContainer().media.deliveryUrlById(id, variant);
  if (url === null) return new Response('Not found', { status: 404 });

  return NextResponse.redirect(new URL(url, request.url), {
    status: 302,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
