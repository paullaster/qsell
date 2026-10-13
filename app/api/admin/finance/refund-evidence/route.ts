import { NextResponse } from 'next/server';
import { getContainer } from '@/server/di/container';
import { run } from '@/server/domains/finance/action-runner';
import { FinanceError } from '@/server/domains/finance/errors';
import { MediaConfigError, MediaError } from '@/server/domains/media/service';
import { maxImageBytes } from '@/server/domains/media/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Multipart overhead allowed on top of the file itself. */
const ENVELOPE_BYTES = 64 * 1024;

/**
 * POST multipart/form-data: `file`, `refundId`, optional `note`.
 * Keeps a photo of a deposit slip, a payment screenshot or a cheque with the refund. A route
 * handler rather than a server action because a photo can be larger than the action body limit.
 * Needs `refunds:upload_evidence`; the file is stored privately and shown only through a
 * signed, expiring link to people who may read refunds.
 */
export async function POST(request: Request) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxImageBytes() + ENVELOPE_BYTES) {
    return NextResponse.json({ ok: false, error: 'That file is too large.' }, { status: 413 });
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ ok: false, error: 'Send the file as multipart form data.' }, { status: 400 });
  }
  const file = form.get('file');
  const refundId = form.get('refundId');
  const note = form.get('note');
  if (!(file instanceof File) || typeof refundId !== 'string' || refundId === '') {
    return NextResponse.json({ ok: false, error: 'Choose a file and a refund.' }, { status: 400 });
  }

  const result = await run(
    'refunds:upload_evidence',
    { surface: 'finance/refunds/detail', action: 'attach_evidence' },
    async (ctx, userId) => {
      const { media, finance } = getContainer();
      try {
        const { asset } = await media.uploadImage({
          data: Buffer.from(await file.arrayBuffer()),
          originalName: file.name,
          purpose: 'finance_evidence',
          visibility: 'private',
          actor: { id: userId, email: '' },
        });
        // Evidence is attached right away, so it must not be swept up as an unused upload.
        await media.markReady([asset.id]);
        await finance.refunds.attach(ctx, refundId, {
          mediaAssetId: asset.id,
          fileName: file.name.slice(0, 200),
          note: typeof note === 'string' && note.trim() ? note.trim().slice(0, 300) : null,
        });
        return { assetId: asset.id };
      } catch (error) {
        if (error instanceof MediaError || error instanceof MediaConfigError) {
          throw new FinanceError('EVIDENCE_REJECTED', error.message);
        }
        throw error;
      }
    },
    [`/admin/finance/refunds/${refundId}`],
  );
  if (!result.ok) {
    return NextResponse.json(result, { status: result.forbidden ? 403 : 400 });
  }
  return NextResponse.json(result);
}
