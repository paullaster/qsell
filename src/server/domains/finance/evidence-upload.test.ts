import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaConfigError, MediaError } from '@/server/domains/media/service';

const requirePermission = vi.fn();
const uploadImage = vi.fn();
const markReady = vi.fn();
const attach = vi.fn();

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Headers()) }));
vi.mock('@/server/domains/access-control/guard', () => ({
  requirePermission: (...a: unknown[]) => requirePermission(...a) as unknown,
  canPermission: () => Promise.resolve(true),
}));
vi.mock('@/server/di/container', () => ({
  getContainer: () => ({
    companySettings: { ensureSeeded: () => Promise.resolve({ id: 'company-1' }) },
    reasonCodes: { ensureSystemReasons: () => Promise.resolve() },
    media: {
      uploadImage: (...a: unknown[]) => uploadImage(...a) as unknown,
      markReady: (...a: unknown[]) => markReady(...a) as unknown,
    },
    finance: {},
  }),
}));

const { evidenceUpload } = await import('./evidence-upload');

const handler = evidenceUpload({
  permission: 'refunds:upload_evidence',
  idField: 'refundId',
  noun: 'a refund',
  surface: 'finance/refunds/detail',
  attach: (...a) => attach(...a) as Promise<void>,
  path: (id) => `/admin/finance/refunds/${id}`,
});

const post = (fields: Record<string, string | File>) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return handler(new Request('http://x.test/upload', { method: 'POST', body: form }));
};
const photo = () => new File([new Uint8Array([1, 2, 3])], 'slip.jpg', { type: 'image/jpeg' });

beforeEach(() => {
  for (const f of [requirePermission, uploadImage, markReady, attach]) f.mockReset();
  requirePermission.mockResolvedValue('user-1');
});

describe('attaching a photo as evidence', () => {
  it('keeps it privately, attaches it to the record, and answers with the asset', async () => {
    uploadImage.mockResolvedValue({ asset: { id: 'asset-1' } });
    const res = await post({ file: photo(), refundId: 'r1', note: ' deposit slip ' });
    expect(await res.json()).toMatchObject({ ok: true, data: { assetId: 'asset-1' } });
    expect(uploadImage).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'finance_evidence', visibility: 'private' }),
    );
    expect(markReady).toHaveBeenCalledWith(['asset-1']);
    expect(attach).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'r1', {
      mediaAssetId: 'asset-1',
      fileName: 'slip.jpg',
      note: 'deposit slip',
    });
  });

  it('says in plain words that photos cannot be kept yet when media storage is not set up, without naming a server setting', async () => {
    uploadImage.mockRejectedValue(
      new MediaConfigError(
        'MEDIA_DRIVER must be set in production: local disk is not durable in containers.',
      ),
    );
    const res = await post({ file: photo(), refundId: 'r1' });
    const body = (await res.json()) as { ok: boolean; error: string; code: string };
    expect(res.status).toBe(400);
    expect(body).toMatchObject({ ok: false, code: 'EVIDENCE_NOT_CONFIGURED' });
    expect(body.error).toContain('no place to keep them');
    expect(body.error).not.toContain('MEDIA_DRIVER');
    expect(attach).not.toHaveBeenCalled();
  });

  it('gives the reason a file was refused (too big, not an image) as it is', async () => {
    uploadImage.mockRejectedValue(
      new MediaError('That file is not an image we can keep.'),
    );
    const res = await post({ file: photo(), refundId: 'r1' });
    expect(await res.json()).toMatchObject({
      ok: false,
      code: 'EVIDENCE_REJECTED',
      error: 'That file is not an image we can keep.',
    });
  });

  it('refuses a request with no file or no record, and one declared too large, before reading anything', async () => {
    expect((await post({ refundId: 'r1' })).status).toBe(400);
    expect((await post({ file: photo() })).status).toBe(400);
    const big = await handler(
      new Request('http://x.test/upload', {
        method: 'POST',
        headers: { 'content-length': String(50 * 1024 * 1024) },
        body: new FormData(),
      }),
    );
    expect(big.status).toBe(413);
    expect(uploadImage).not.toHaveBeenCalled();
  });

  it('refuses someone without the permission', async () => {
    const { AccessDeniedError } = await import('@/server/domains/access-control/engine');
    requirePermission.mockRejectedValue(
      new AccessDeniedError('refunds:upload_evidence', { allowed: false, reason: 'deny-grant' }),
    );
    const res = await post({ file: photo(), refundId: 'r1' });
    expect(res.status).toBe(403);
    expect(uploadImage).not.toHaveBeenCalled();
  });
});
