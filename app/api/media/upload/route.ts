import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { auth } from '@/auth';
import { getContainer } from '@/server/di/container';
import { AccessDeniedError, requirePermission } from '@/server/domains/access-control/guard';
import { MediaConfigError, MediaError } from '@/server/domains/media/service';
import { maxImageBytes } from '@/server/domains/media/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Multipart overhead allowed on top of the file itself. */
const ENVELOPE_BYTES = 64 * 1024;

/**
 * POST multipart/form-data: `file` (required), `purpose`, `visibility`, `altText`.
 * A route handler rather than a Server Action: files can exceed the action body
 * limit, and a stable HTTP endpoint is what upload progress UIs want.
 */
export async function POST(request: Request) {
  const session = await auth();
  const sessionUserId = session?.user.id;
  if (session === null || sessionUserId === undefined || sessionUserId === '') {
    return NextResponse.json({ error: 'Sign in to upload.' }, { status: 401 });
  }

  let userId: string;
  try {
    userId = await requirePermission('media:upload');
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return NextResponse.json({ error: 'You do not have permission to upload media.' }, { status: 403 });
    }
    return NextResponse.json({ error: 'Your session cannot upload right now.' }, { status: 403 });
  }

  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxImageBytes() + ENVELOPE_BYTES) {
    return NextResponse.json({ error: 'That file is too large.' }, { status: 413 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Send the image as multipart form data.' }, { status: 400 });
  }
  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Choose an image to upload.' }, { status: 400 });
  }
  const visibilityField = form.get('visibility');
  if (visibilityField !== null && visibilityField !== 'public' && visibilityField !== 'private') {
    return NextResponse.json({ error: 'Invalid visibility.' }, { status: 400 });
  }
  const purposeField = form.get('purpose');
  const altField = form.get('altText');

  try {
    const result = await getContainer().media.uploadImage({
      data: Buffer.from(await file.arrayBuffer()),
      originalName: file.name,
      purpose: typeof purposeField === 'string' && purposeField !== '' ? purposeField : undefined,
      visibility: visibilityField ?? undefined,
      altText: typeof altField === 'string' ? altField : undefined,
      actor: { id: userId, email: session.user.email },
    });
    return NextResponse.json(result, { status: result.deduplicated ? 200 : 201 });
  } catch (error) {
    if (error instanceof MediaError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    if (error instanceof MediaConfigError) {
      // The operator needs to fix settings; the user just needs to know uploads are off.
      console.error('[media] uploads are not configured:', error.message);
      Sentry.captureException(error, { tags: { area: 'media', operation: 'configuration' } });
      return NextResponse.json(
        { error: 'Image uploads are not set up on this server yet. You can still add an image by pasting a link.' },
        { status: 503 },
      );
    }
    console.error('[media] upload failed', error);
    Sentry.captureException(error, { tags: { area: 'media', operation: 'upload' } });
    return NextResponse.json({ error: 'The upload failed. Please try again.' }, { status: 502 });
  }
}
