import { NextResponse } from 'next/server';
import { getContainer } from '@/server/di/container';
import { maxFileBytes } from '@/server/domains/vendors/file-store';
import { portal } from '@/server/domains/vendors/portal-runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ENVELOPE_BYTES = 64 * 1024;

/**
 * POST multipart/form-data with `file`: a scan of the vendor's own credit note. The vendor comes from the
 * session, the kind of file from its own bytes. The answer is the file's id, which the invoice form then refers to.
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
  if (!(file instanceof File)) return NextResponse.json({ ok: false, error: 'Choose a file.' }, { status: 400 });
  const result = await portal('upload_credit_file', async (me) => await getContainer().creditMemoPortal.addFile(me, me.companyId, { originalName: file.name, data: Buffer.from(await file.arrayBuffer()) }));
  let status = 200;
  if (!result.ok) status = result.signedOut === true ? 401 : 400;
  return NextResponse.json(result, { status, headers: { 'Cache-Control': 'no-store' } });
}
