import { NextResponse } from 'next/server';
import { getContainer } from '@/server/di/container';
import { maxFileBytes } from '@/server/domains/vendors/file-store';
import { portal } from '@/server/domains/vendors/portal-runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Multipart overhead allowed on top of the file itself. */
const ENVELOPE_BYTES = 64 * 1024;

/**
 * POST multipart/form-data: `file`, `documentTypeId`, optional `issuedOn` and `expiresOn`. A route handler rather than a server action
 * because a scan can be larger than the action body limit. The vendor comes from the session, the file's type from its own bytes.
 */
export async function POST(request: Request) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxFileBytes() + ENVELOPE_BYTES) {
    return NextResponse.json({ ok: false, error: 'That file is too large.' }, { status: 413 });
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ ok: false, error: 'Send the file as multipart form data.' }, { status: 400 });
  }
  const file = form.get('file');
  const typeId = form.get('documentTypeId');
  const text = (key: string): string => {
    const v = form.get(key);
    return typeof v === 'string' ? v : '';
  };
  if (!(file instanceof File) || typeof typeId !== 'string') {
    return NextResponse.json({ ok: false, error: 'Choose a file and say which document it is.' }, { status: 400 });
  }
  const result = await portal('upload_document', async (me) =>
    await getContainer().vendorProfile.addDocument(me, me.companyId, {
      documentTypeId: typeId,
      originalName: file.name,
      data: Buffer.from(await file.arrayBuffer()),
      issuedOn: text('issuedOn'),
      expiresOn: text('expiresOn'),
    }), 'vendor_upload');
  let status = 200;
  if (!result.ok) status = result.signedOut === true ? 401 : 400;
  return NextResponse.json(result, { status, headers: { 'Cache-Control': 'no-store' } });
}
