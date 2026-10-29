import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readWishlistShareToken } from './share-token';

const { auth, ids, merge } = vi.hoisted(() => ({
  auth: vi.fn(),
  ids: vi.fn(),
  merge: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth }));
vi.mock('./service', () => ({ WishlistService: { ids, merge } }));

const { createWishlistShareAction } = await import('./actions');

beforeEach(() => {
  vi.stubEnv('AUTH_SECRET', 'wishlist-share-test-secret');
  auth.mockReset();
  ids.mockReset().mockResolvedValue(['product-1', 'product-2']);
  merge.mockReset().mockResolvedValue(['product-1', 'product-2']);
});

afterEach(() => vi.unstubAllEnvs());

describe('createWishlistShareAction', () => {
  it('merges this device list and returns a link token readable on another device', async () => {
    auth.mockResolvedValue({ user: { id: 'customer-1', role: 'customer' } });

    const result = await createWishlistShareAction(['product-1', 'product-2']);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(merge).toHaveBeenCalledWith('customer-1', ['product-1', 'product-2']);
    expect(
      readWishlistShareToken(result.data.token, new Date(), 'wishlist-share-test-secret'),
    ).toMatchObject({ userId: 'customer-1' });
  });

  it('asks non-customer sessions to sign in rather than returning an unusable link', async () => {
    auth.mockResolvedValue({ user: { id: 'staff-1', role: 'admin' } });

    await expect(createWishlistShareAction(['product-1'])).resolves.toEqual({
      ok: false,
      error: 'Sign in with a customer account to create a wishlist link for other devices.',
    });
    expect(merge).not.toHaveBeenCalled();
  });
});
