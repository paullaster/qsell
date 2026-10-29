import { describe, expect, it } from 'vitest';
import { createWishlistShareToken, readWishlistShareToken } from './share-token';

const secret = 'test-secret-that-is-never-logged';
const now = new Date('2026-10-28T00:00:00Z');

describe('wishlist share tokens', () => {
  it('encrypts the account id and allows the link until its 30-day expiry', () => {
    const issued = createWishlistShareToken('private-account-id', now, secret);

    expect(issued.token).not.toContain('private-account-id');
    expect(readWishlistShareToken(issued.token, now, secret)).toEqual({
      userId: 'private-account-id',
      expiresAt: issued.expiresAt,
    });
  });

  it('rejects a changed token, the wrong key and an expired link', () => {
    const { token, expiresAt } = createWishlistShareToken('account-1', now, secret);
    const changed = `${token.slice(0, 40)}${token[40] === 'a' ? 'b' : 'a'}${token.slice(41)}`;

    expect(readWishlistShareToken(changed, now, secret)).toBeNull();
    expect(readWishlistShareToken(token, now, 'another-secret')).toBeNull();
    expect(readWishlistShareToken(token, new Date(expiresAt * 1000), secret)).toBeNull();
  });

  it('rejects malformed tokens without throwing', () => {
    expect(readWishlistShareToken('not-a-share-token', now, secret)).toBeNull();
    expect(readWishlistShareToken('x'.repeat(513), now, secret)).toBeNull();
  });
});
