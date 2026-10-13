import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { EncryptedCredentialsBlob } from './types';

/**
 * The master data-encryption key seals every provider credential. It is one of the two things
 * that cannot live in the database (the other is the database URL), because it is what protects
 * the database's secrets. There is no fallback key: without one the system refuses to seal or
 * open anything, in every environment.
 *
 * Supplied as, in this order:
 *   DATA_ENCRYPTION_KEY_FILE  path to a file holding the key (a mounted secret)
 *   DATA_ENCRYPTION_KEY       the key itself (32 bytes base64, or any passphrase)
 *   PAYMENT_DATA_KEY          the old name, still read
 * with DATA_ENCRYPTION_KEY_ID naming it (default "k1"). To rotate, give the new key a new id and
 * list the retired ones in DATA_ENCRYPTION_OLD_KEYS as JSON `{"k1":"<key>"}`; old blobs keep
 * opening, and `needsResealing` tells a job which ones to seal again under the current key.
 */
export class MissingEncryptionKeyError extends Error {
  constructor() {
    super(
      'No data-encryption key is configured. Set DATA_ENCRYPTION_KEY (32 bytes, base64) or DATA_ENCRYPTION_KEY_FILE before saving or using provider credentials.',
    );
    this.name = 'MissingEncryptionKeyError';
  }
}

const DEFAULT_KEY_ID = 'k1';

/** Same derivation as before key ids existed, so blobs sealed earlier still open. */
function toKey(raw: string): Buffer {
  const buf = Buffer.from(raw, 'base64');
  if (buf.length === 32) return buf;
  return createHash('sha256').update(raw).digest();
}

function readCurrentRaw(): string {
  const file = process.env.DATA_ENCRYPTION_KEY_FILE;
  if (file) {
    try {
      const fromFile = readFileSync(file, 'utf8').replace(/\r?\n$/, '');
      if (fromFile) return fromFile;
    } catch {
      throw new MissingEncryptionKeyError();
    }
  }
  return process.env.DATA_ENCRYPTION_KEY || process.env.PAYMENT_DATA_KEY || '';
}

export function currentKeyId(): string {
  return process.env.DATA_ENCRYPTION_KEY_ID?.trim() || DEFAULT_KEY_ID;
}

function currentKey(): Buffer {
  const raw = readCurrentRaw();
  if (!raw) throw new MissingEncryptionKeyError();
  return toKey(raw);
}

function oldKeys(): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const json = process.env.DATA_ENCRYPTION_OLD_KEYS;
  if (!json) return out;
  try {
    const parsed = JSON.parse(json) as Record<string, string>;
    for (const [id, raw] of Object.entries(parsed)) if (raw) out.set(id, toKey(raw));
  } catch {
    /* an unreadable list means no old keys; opening an old blob then fails loudly */
  }
  return out;
}

/** True when this blob was not sealed under the current key (so a job should seal it again). */
export function needsResealing(blob: EncryptedCredentialsBlob | null | undefined): boolean {
  if (!blob) return false;
  return blob.v !== 2 || blob.kid !== currentKeyId();
}

export function encryptCredentials(plaintext: Record<string, unknown>): EncryptedCredentialsBlob {
  const iv = randomBytes(12);
  const kid = currentKeyId();
  const cipher = createCipheriv('aes-256-gcm', currentKey(), iv);
  cipher.setAAD(Buffer.from(kid, 'utf8'));
  const json = Buffer.from(JSON.stringify(plaintext), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(json), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 2,
    kid,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function decryptCredentials<T extends Record<string, unknown> = Record<string, unknown>>(
  blob: EncryptedCredentialsBlob | null | undefined,
): T | null {
  if (!blob || (blob.v !== 1 && blob.v !== 2)) return null;
  let key: Buffer;
  if (blob.v === 2 && blob.kid && blob.kid !== currentKeyId()) {
    const old = oldKeys().get(blob.kid);
    if (!old) {
      throw new Error(
        `These credentials were sealed with key "${blob.kid}", which is not available. Provide it in DATA_ENCRYPTION_OLD_KEYS.`,
      );
    }
    key = old;
  } else {
    key = currentKey();
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
  if (blob.v === 2 && blob.kid) decipher.setAAD(Buffer.from(blob.kid, 'utf8'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(blob.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(plain.toString('utf8')) as T;
}

/** Fields whose value is a secret: shown only as "saved", with no characters of it. */
const SECRET_FIELD = /secret|passkey|pass_key|private|password|token|api_?key/i;

/**
 * Redact credentials for the admin UI. Secrets are never shown, not even their last characters;
 * identifiers (a consumer key, a shortcode) show only their last 4 so a person can tell which one
 * is saved.
 */
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
    if (SECRET_FIELD.test(k) || v.length <= 4) out[k] = '••••••••';
    else out[k] = `${'•'.repeat(Math.min(12, v.length - 4))}${v.slice(-4)}`;
  }
  return out;
}
