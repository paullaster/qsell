import { NextResponse } from 'next/server';
import { requireUser } from '@/server/domains/access-control/guard';
import { AccessDeniedError } from '@/server/domains/access-control/engine';
import { getContainer } from '@/server/di/container';
import { PROOF_PURPOSE } from '@/server/domains/delivery/door';
import { MediaConfigError, MediaError } from '@/server/domains/media/service';
import { maxImageBytes } from '@/server/domains/media/validation';

/** Multipart overhead allowed on top of the file itself. */
const ENVELOPE_BYTES = 64 * 1024;

/**
 * POST multipart/form-data: `file`. Keeps the photo a rider took at a door. A route handler rather than a server action because a
 * phone's photo can be larger than the action body limit. Only a rider (the server finds the rider for the signed-in account) may
 * add one; it is stored privately and is not used until the rider's delivery or failed attempt names it.
 */
export async function POST(request: Request): Promise<Response> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxImageBytes() + ENVELOPE_BYTES) return NextResponse.json({ ok: false, error: 'That photo is too large.' }, { status: 413 });
  let userId: string;
  try {
    userId = await requireUser();
  } catch (error: unknown) {
    if (error instanceof AccessDeniedError) return NextResponse.json({ ok: false, error: 'Sign in to use the rider app.' }, { status: 401 });
    throw error;
  }
  const { deliveryRiders, media } = getContainer();
  if ((await deliveryRiders.forUser(userId)) === null) return NextResponse.json({ ok: false, error: 'This account is not set up to ride.' }, { status: 403 });
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ ok: false, error: 'Send the photo as multipart form data.' }, { status: 400 });
  }
  const file = form.get('file');
  if (!(file instanceof File)) return NextResponse.json({ ok: false, error: 'Choose a photo.' }, { status: 400 });
  try {
    const { asset } = await media.uploadImage({ data: Buffer.from(await file.arrayBuffer()), originalName: file.name, purpose: PROOF_PURPOSE, visibility: 'private', actor: { id: userId, email: '' } });
    return NextResponse.json({ ok: true, data: { photoId: asset.id } });
  } catch (error: unknown) {
    if (error instanceof MediaConfigError) return NextResponse.json({ ok: false, error: 'Photos cannot be saved yet: this installation has no place to keep them. Ask the shop to set up media storage.' }, { status: 503 });
    if (error instanceof MediaError) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    console.error('[rider-photo]', error);
    return NextResponse.json({ ok: false, error: 'The photo could not be saved. Try again.' }, { status: 500 });
  }
}
