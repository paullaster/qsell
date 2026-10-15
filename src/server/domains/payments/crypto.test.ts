import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  MissingEncryptionKeyError,
  maskCredentials,
  decryptCredentials,
  encryptCredentials,
  needsResealing,
} from './crypto';
import { required } from '@/lib/values';

const KEYS = ['DATA_ENCRYPTION_KEY', 'PAYMENT_DATA_KEY', 'DATA_ENCRYPTION_KEY_ID', 'DATA_ENCRYPTION_OLD_KEYS', 'DATA_ENCRYPTION_KEY_FILE'];
const saved: Record<string, string | undefined> = {};
const k1 = randomBytes(32).toString('base64');
const k2 = randomBytes(32).toString('base64');

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('credential sealing', () => {
  it('refuses to seal or open anything without a key, in every environment', () => {
    expect(() => encryptCredentials({ a: 'b' })).toThrow(MissingEncryptionKeyError);
    process.env.DATA_ENCRYPTION_KEY = k1;
    const blob = encryptCredentials({ a: 'b' });
    delete process.env.DATA_ENCRYPTION_KEY;
    expect(() => decryptCredentials(blob)).toThrow(MissingEncryptionKeyError);
  });

  it('round-trips and records the key id on the blob', () => {
    process.env.DATA_ENCRYPTION_KEY = k1;
    const blob = encryptCredentials({ secret: 'x' });
    expect(blob.v).toBe(2);
    expect(blob.kid).toBe('k1');
    expect(decryptCredentials(blob)).toEqual({ secret: 'x' });
    expect(needsResealing(blob)).toBe(false);
  });

  it('rotates: old blobs open with the retired key and are flagged for resealing', () => {
    process.env.DATA_ENCRYPTION_KEY = k1;
    const old = encryptCredentials({ secret: 'x' });
    process.env.DATA_ENCRYPTION_KEY = k2;
    process.env.DATA_ENCRYPTION_KEY_ID = 'k2';
    expect(() => decryptCredentials(old)).toThrow(/k1/);
    process.env.DATA_ENCRYPTION_OLD_KEYS = JSON.stringify({ k1 });
    expect(decryptCredentials(old)).toEqual({ secret: 'x' });
    expect(needsResealing(old)).toBe(true);
    const fresh = encryptCredentials(required(decryptCredentials(old)));
    expect(fresh.kid).toBe('k2');
    expect(needsResealing(fresh)).toBe(false);
  });

  it('opens blobs sealed before key ids existed (v1) with the current key', async () => {
    process.env.DATA_ENCRYPTION_KEY = k1;
    const { createCipheriv, randomBytes: rb } = await import('node:crypto');
    const iv = rb(12);
    const c = createCipheriv('aes-256-gcm', Buffer.from(k1, 'base64'), iv);
    const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify({ legacy: '1' }))), c.final()]);
    const blob = { v: 1 as const, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ciphertext: ct.toString('base64') };
    expect(decryptCredentials(blob)).toEqual({ legacy: '1' });
    expect(needsResealing(blob)).toBe(true);
  });

  it('detects a tampered key id', () => {
    process.env.DATA_ENCRYPTION_KEY = k1;
    const blob = encryptCredentials({ a: 'b' });
    process.env.DATA_ENCRYPTION_OLD_KEYS = JSON.stringify({ evil: k1 });
    expect(() => decryptCredentials({ ...blob, kid: 'evil' })).toThrow();
  });

  it('shows secrets as saved without any of their characters, and identifiers by their last four', () => {
    const masked = maskCredentials({ consumerKey: 'abcdefgh1234', consumerSecret: 'supersecret9999', passkey: 'bfb279f9aa9bdbcf', shortcode: '174379', privateKeyPem: '-----BEGIN-----', empty: '' });
    expect(masked).toEqual({
      consumerKey: '••••••••1234',
      consumerSecret: '••••••••',
      passkey: '••••••••',
      shortcode: '••4379',
      privateKeyPem: '••••••••',
      empty: '',
    });
    expect(JSON.stringify(masked)).not.toContain('9999');
  });
});
