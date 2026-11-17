import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.fn();
const canPermission = vi.fn();
const uploadImage = vi.fn();

vi.mock('@/auth', () => ({ auth: (...args: unknown[]) => auth(...args) as unknown }));
vi.mock('@/server/domains/access-control/guard', async (original) => ({ ...(await original<Record<string, unknown>>()), canPermission: (...args: unknown[]) => canPermission(...args) as unknown }));
vi.mock('@/server/di/container', () => ({ getContainer: () => ({ media: { uploadImage } }) }));

const { POST } = await import('../../../../app/api/visits/photo/route');
const { MediaConfigError, MediaError } = await import('@/server/domains/media/service');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const send = (form: FormData): Promise<Response> => POST(new Request('http://shop.test/api/visits/photo', { method: 'POST', body: form }));
const withFile = (): FormData => {
  const form = new FormData();
  form.set('file', new File([png], 'door.png', { type: 'image/png' }));
  return form;
};
const signedIn = () => auth.mockResolvedValue({ user: { id: 'crew-1', role: 'super_admin', isStaff: true } });

beforeEach(() => {
  vi.clearAllMocks();
  canPermission.mockResolvedValue(true);
  uploadImage.mockResolvedValue({ asset: { id: 'asset-1' } });
});

describe('the visit photo route', () => {
  it('refuses a call with no sign-in, and keeps nothing', async () => {
    auth.mockResolvedValue(null);
    const r = await send(withFile());
    expect(r.status).toBe(401);
    expect(uploadImage).not.toHaveBeenCalled();
  });
  it('refuses someone who may not work on visits', async () => {
    signedIn();
    canPermission.mockResolvedValue(false);
    const r = await send(withFile());
    expect(r.status).toBe(403);
    expect(canPermission).toHaveBeenCalledWith('visits:work');
    expect(uploadImage).not.toHaveBeenCalled();
  });
  it('asks for a photo when there is none, and refuses one that is too large by its declared size', async () => {
    signedIn();
    const none = new FormData();
    none.set('other', 'x');
    expect((await send(none)).status).toBe(400);
    const big = await POST(new Request('http://shop.test/api/visits/photo', { method: 'POST', body: withFile(), headers: { 'content-length': String(500 * 1024 * 1024) } }));
    expect(big.status).toBe(413);
    expect(uploadImage).not.toHaveBeenCalled();
  });
  it('keeps the picture privately for the visit purpose, under the person who sent it, and gives back only its id', async () => {
    signedIn();
    const r = await send(withFile());
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, data: { photoId: 'asset-1' } });
    expect(uploadImage).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'visit_photo', visibility: 'private', actor: { id: 'crew-1', email: '' } }));
  });
  it('says in words when the picture is refused or there is nowhere to keep it', async () => {
    signedIn();
    uploadImage.mockRejectedValueOnce(new MediaError('That file is not a picture.'));
    const notPicture = await send(withFile());
    expect(notPicture.status).toBe(400);
    expect(await notPicture.json()).toEqual({ ok: false, error: 'That file is not a picture.' });
    uploadImage.mockRejectedValueOnce(new MediaConfigError('No storage'));
    const noStorage = await send(withFile());
    expect(noStorage.status).toBe(503);
    expect(JSON.stringify(await noStorage.json())).toContain('no place to keep them');
  });
});
