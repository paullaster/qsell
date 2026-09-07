import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import type { EncryptedCredentialsBlob } from './types';

/**
 * Application-level data key for sealing payment credentials at rest.
 * This is infrastructure crypto — not a payment-provider credential.
 */
function getDataKey(): Buffer {
  const raw = process.env.DATA_ENCRYPTION_KEY || process.env.PAYMENT_DATA_KEY || '';
  if (!raw) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('DATA_ENCRYPTION_KEY must be set in production');
    }
    // Dev-only deterministic fallback when unset
    return createHash('sha256').update('qsell-dev-data-encryption-key').digest();
  }
  try {
    const buf = Buffer.from(raw, 'base64');
    if (buf.length === 32) return buf;
  } catch {
    /* fall through */
  }
  return createHash('sha256').update(raw).digest();
}

export function encryptCredentials(plaintext: Record<string, unknown>): EncryptedCredentialsBlob {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getDataKey(), iv);
  const json = Buffer.from(JSON.stringify(plaintext), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(json), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function decryptCredentials<T extends Record<string, unknown> = Record<string, unknown>>(
  blob: EncryptedCredentialsBlob | null | undefined,
): T | null {
  if (!blob || blob.v !== 1) return null;
  const decipher = createDecipheriv('aes-256-gcm', getDataKey(), Buffer.from(blob.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(blob.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(plain.toString('utf8')) as T;
}

/** Redact secrets for admin UI — show only last 4 chars of string fields. */
export function maskCredentials(
  creds: Record<string, unknown> | null,
): Record<string, string> | null {
  if (!creds) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(creds)) {
    if (typeof v !== 'string' || v.length === 0) {
      out[k] = '';
      continue;
    }
    if (v.length <= 4) out[k] = '••••';
    else out[k] = `${'•'.repeat(Math.min(12, v.length - 4))}${v.slice(-4)}`;
  }
  return out;
}
