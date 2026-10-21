import { NextResponse } from 'next/server';
import type { PermissionKey } from '@/server/domains/access-control/permissions';
import { getContainer } from '@/server/di/container';
import { run } from './action-runner';
import { FinanceError, type FinanceContext } from './errors';
import type { FinanceServices } from './index';
import { MediaConfigError, MediaError } from '@/server/domains/media/service';
import { maxImageBytes } from '@/server/domains/media/validation';
import { trimToNull } from '@/lib/values';

/** Multipart overhead allowed on top of the file itself. */
const ENVELOPE_BYTES = 64 * 1024;

export interface EvidenceRoute {
  permission: PermissionKey;
  /** The form field that names what the evidence is for (receiptId, refundId, fileId). */
  idField: string;
  /** What it is for, in a sentence ("a receipt"). */
  noun: string;
  surface: string;
  attach: (finance: FinanceServices, ctx: FinanceContext, id: string, file: { mediaAssetId: string; fileName: string; note: string | null }) => Promise<void>;
  /** The page to refresh. */
  path: (id: string) => string;
}

/**
 * POST multipart/form-data: `file`, the id field, optional `note`. Keeps a photo of a deposit slip, a payment screenshot or a
 * bank confirmation with a finance record. A route handler rather than a server action because a photo can be larger than the
 * action body limit. The file is stored privately and shown only through a signed, expiring link.
 */
export function evidenceUpload(route: EvidenceRoute): (request: Request) => Promise<Response> {
  return async (request) => {
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
    const id = form.get(route.idField);
    const note = form.get('note');
    if (!(file instanceof File) || typeof id !== 'string' || id === '') {
      return NextResponse.json({ ok: false, error: `Choose a file and ${route.noun}.` }, { status: 400 });
    }
    const result = await run(
      route.permission,
      { surface: route.surface, action: 'attach_evidence' },
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
          await route.attach(finance, ctx, id, { mediaAssetId: asset.id, fileName: file.name.slice(0, 200), note: typeof note === 'string' ? (trimToNull(note)?.slice(0, 300) ?? null) : null });
          return { assetId: asset.id };
        } catch (error) {
          // Where photos are kept is set up by whoever runs the server; the name of that setting is not for the screen.
          if (error instanceof MediaConfigError) throw new FinanceError('EVIDENCE_NOT_CONFIGURED', 'Photos cannot be saved yet: this installation has no place to keep them. Ask whoever looks after the server to set up media storage.');
          if (error instanceof MediaError) throw new FinanceError('EVIDENCE_REJECTED', error.message);
          throw error;
        }
      },
      [route.path(id)],
    );
    if (!result.ok) return NextResponse.json(result, { status: result.forbidden ? 403 : 400 });
    return NextResponse.json(result);
  };
}
