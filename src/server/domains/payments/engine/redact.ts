import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { has, readText } from '@/lib/values';

/**
 * What may be written to a log. Secrets never are, phone numbers are masked, and the secret
 * path segment of a callback address is hidden. Applied to everything sent to or received from a
 * payment platform before it is stored.
 */
const SECRET_KEY = /(pass(word|key)?|secret|securitycredential|credential|authorization|api[-_]?key|private[-_]?key|consumer(key|secret)|app[-_]?key|^token$|access[-_]?token|certificate|cert$)/i;
const PHONE_KEY = /^(phone(number)?|msisdn|partya|partyb|billedphonenumber|nominatednumber|receiverparty|customerphone)$/i;

export function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 9) return '•••';
  return `${digits.slice(0, 4)}•••••${digits.slice(-3)}`;
}

/** A one-way fingerprint of a phone number, so two payments by the same person can be seen without keeping the number. */
export function phoneFingerprint(value: string): string {
  const digits = value.replace(/\D/g, '');
  const key = digits.length >= 9 ? digits.slice(-9) : digits;
  return createHash('sha256').update(`phone:${key}`).digest('hex').slice(0, 32);
}

export function redactDeep<T>(value: T): T {
  const walk = (v: unknown, key?: string): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (typeof v === 'object' && v !== null) {
      const rec = v as Record<string, unknown>;
      // The M-Pesa metadata shape: { Name: 'PhoneNumber', Value: 254... }
      const named = typeof rec.Name === 'string' && PHONE_KEY.test(rec.Name);
      return Object.fromEntries(
        Object.entries(rec).map(([k, x]) => {
          if (SECRET_KEY.test(k)) return [k, '[REDACTED]'];
          if (named && k === 'Value' && x != null) return [k, maskPhone(readText(x))];
          return [k, walk(x, k)];
        }),
      );
    }
    if (typeof v === 'string' && /^https?:\/\//i.test(v)) return redactUrl(v);
    if (typeof v === 'string' && has(key) && PHONE_KEY.test(key) && /^\+?\d{9,15}$/.test(v.replace(/\s/g, ''))) return maskPhone(v);
    if (typeof v === 'number' && has(key) && PHONE_KEY.test(key) && String(v).length >= 9) return maskPhone(String(v));
    return v;
  };
  return walk(value) as T;
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k, /^(authorization|cookie|x-api-key|api-key|proxy-authorization)$/i.test(k) ? '[REDACTED]' : v]),
  );
}

/** A callback address carries a secret as its last path segment; the log keeps only the shape. */
export function redactUrl(url: string): string {
  return url.replace(/\/([A-Za-z0-9_-]{20,})(\/?(?:\?.*)?)$/, '/[secret]$2').replace(/([?&](?:token|key|secret)=)[^&]+/gi, '$1[REDACTED]');
}

/** Safaricom refuses callback addresses containing these words (any letter case). */
const FORBIDDEN_IN_URL = /(m-?pesa|safaricom|exe|exec|cmd|sql|query)/i;

/** A new unguessable secret (for callback addresses), without any word a platform would refuse in an address. */
export function newSecret(): string {
  for (;;) {
    const secret = randomBytes(32).toString('base64url');
    if (!FORBIDDEN_IN_URL.test(secret)) return secret;
  }
}

export const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('hex');

/** Constant-time comparison of a presented secret with a stored hash. */
export function secretMatches(presented: string, storedHash: string | null | undefined): boolean {
  if (!has(storedHash) || !has(presented)) return false;
  const a = Buffer.from(hashSecret(presented), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export const bodyHash = (text: string) => createHash('sha256').update(text).digest('hex');

/** Is an address inside one of the allowed ranges ("1.2.3.4" or "1.2.3.0/24")? IPv4 only; IPv6 never matches a CIDR. */
export function ipAllowed(ip: string | null, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  if (!has(ip)) return false;
  const clean = ip.replace(/^::ffff:/, '');
  const num = (a: string) => a.split('.').reduce((n, p) => (n << 8) + Number(p), 0) >>> 0;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(clean)) return allowed.includes(clean);
  for (const entry of allowed) {
    const [base, bits] = entry.trim().split('/');
    if (!has(base) || !/^\d{1,3}(\.\d{1,3}){3}$/.test(base)) continue;
    const prefix = bits === undefined ? 32 : Number(bits);
    if (!(prefix >= 0 && prefix <= 32)) continue;
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    if ((num(clean) & mask) === (num(base) & mask)) return true;
  }
  return false;
}
