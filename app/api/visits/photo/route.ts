import { NextResponse } from 'next/server';
import { canPermission, requireUser } from '@/server/domains/access-control/guard';
import { AccessDeniedError } from '@/server/domains/access-control/engine';
import { getContainer } from '@/server/di/container';
import { VISIT_PHOTO_PURPOSE } from '@/server/domains/delivery/visits';
import { MediaConfigError, MediaError } from '@/server/domains/media/service';
import { maxImageBytes } from '@/server/domains/media/validation';

/** Multipart overhead allowed on top of the file itself. */
const ENVELOPE_BYTES = 64 * 1024;

/**
 * POST multipart/form-data: `file`. Keeps a photo taken on a visit. A route handler rather than a server action because a phone's photo
 * can be larger than the action body limit. Only someone who may work on visits can add one; it is stored privately and is not used until
 * `addVisitPhotoAction` names it for a visit this person may work on.
 */
export async function POST(request: Request): Promise<Response> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxImageBytes() + ENVELOPE_BYTES) return NextResponse.json({ ok: false, error: 'That photo is too large.' }, { status: 413 });
  let userId: string;
  try {
    userId = await requireUser();
  } catch (error: unknown) {
    if (error instanceof AccessDeniedError) return NextResponse.json({ ok: false, error: 'Sign in to add a photo.' }, { status: 401 });
    throw error;
  }
  if (!(await canPermission('visits:work'))) return NextResponse.json({ ok: false, error: 'You do not have permission to add photos to visits.' }, { status: 403 });
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ ok: false, error: 'Send the photo as multipart form data.' }, { status: 400 });
  }
  const file = form.get('file');
  if (!(file instanceof File)) return NextResponse.json({ ok: false, error: 'Choose a photo.' }, { status: 400 });
  try {
    const { asset } = await getContainer().media.uploadImage({ data: Buffer.from(await file.arrayBuffer()), originalName: file.name, purpose: VISIT_PHOTO_PURPOSE, visibility: 'private', actor: { id: userId, email: '' } });
    return NextResponse.json({ ok: true, data: { photoId: asset.id } });
  } catch (error: unknown) {
    if (error instanceof MediaConfigError) return NextResponse.json({ ok: false, error: 'Photos cannot be saved yet: this installation has no place to keep them. Ask the administrator to set one up.' }, { status: 503 });
    if (error instanceof MediaError) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    console.error('[visit-photo]', error);
    return NextResponse.json({ ok: false, error: 'The photo could not be saved. Try again.' }, { status: 500 });
  }
}
