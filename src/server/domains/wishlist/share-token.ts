import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const WISHLIST_SHARE_TTL_SECONDS = 30 * 24 * 60 * 60;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_TOKEN_LENGTH = 512;

export interface WishlistShareClaims {
  userId: string;
  expiresAt: number;
}

function encryptionKey(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

/** Opaque, authenticated and expiring bearer link; the account id is encrypted inside the token. */
export function createWishlistShareToken(
  userId: string,
  now: Date,
  secret: string,
): { token: string; expiresAt: number } {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const expiresAt = issuedAt + WISHLIST_SHARE_TTL_SECONDS;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const payload = Buffer.from(JSON.stringify({ userId, issuedAt, expiresAt }));
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const token = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
  return { token, expiresAt };
}

export function readWishlistShareToken(
  token: string,
  now: Date,
  secret: string,
): WishlistShareClaims | null {
  if (token.length > MAX_TOKEN_LENGTH || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  try {
    const packed = Buffer.from(token, 'base64url');
    if (packed.length <= IV_BYTES + TAG_BYTES) return null;
    const iv = packed.subarray(0, IV_BYTES);
    const tag = packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = packed.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(secret), iv);
    decipher.setAuthTag(tag);
    const payload = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    const claims: unknown = JSON.parse(payload);
    if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) return null;
    const value = claims as { userId?: unknown; issuedAt?: unknown; expiresAt?: unknown };
    const nowSeconds = Math.floor(now.getTime() / 1000);
    if (
      typeof value.userId !== 'string' ||
      value.userId === '' ||
      value.userId.length > 100 ||
      typeof value.issuedAt !== 'number' ||
      typeof value.expiresAt !== 'number' ||
      value.issuedAt > nowSeconds ||
      value.expiresAt <= nowSeconds ||
      value.expiresAt - value.issuedAt !== WISHLIST_SHARE_TTL_SECONDS
    ) {
      return null;
    }
    return { userId: value.userId, expiresAt: value.expiresAt };
  } catch {
    return null;
  }
}
