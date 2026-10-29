import { beforeEach, describe, expect, it, vi } from 'vitest';

const { deleteAsset, requirePermission } = vi.hoisted(() => ({
  deleteAsset: vi.fn(),
  requirePermission: vi.fn(),
}));

vi.mock('@/server/domains/access-control/guard', () => ({ requirePermission }));
vi.mock('@/server/di/container', () => ({
  getContainer: () => ({ media: { deleteAsset } }),
}));
vi.mock('@/auth', () => ({ auth: vi.fn() }));
vi.mock('./service', () => ({
  MediaConfigError: class MediaConfigError extends Error {},
  MediaError: class MediaError extends Error {},
}));

const { deleteMediaAction } = await import('./actions');
const { MediaConfigError } = await import('./service');

beforeEach(() => {
  deleteAsset.mockReset();
  requirePermission.mockReset().mockResolvedValue('staff-1');
});

describe('deleteMediaAction', () => {
  it('returns a safe recovery message when the stored provider is not configured', async () => {
    deleteAsset.mockRejectedValue(
      new MediaConfigError('MEDIA_DRIVER=cloudinary needs CLOUDINARY_API_SECRET.'),
    );

    await expect(deleteMediaAction('media-1')).resolves.toEqual({
      ok: false,
      error:
        'Image storage is not configured for this action. Ask an administrator to restore the provider settings or migrate the image, then try again.',
    });
    expect(deleteAsset).toHaveBeenCalledWith('media-1');
    expect(requirePermission).toHaveBeenCalledWith('media:delete');
  });
});
