import { constants, createPublicKey, publicEncrypt } from 'node:crypto';

import { has } from '@/lib/has';

/** Daraja timestamps are East Africa Time, yyyyMMddHHmmss. */
export function darajaTimestamp(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}${get('month')}${get('day')}${get('hour') === '24' ? '00' : get('hour')}${get('minute')}${get('second')}`;
}

/** The STK password: base64(shortcode + passkey + timestamp). */
export function stkPassword(shortcode: string, passkey: string, timestamp: string): string {
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
}

/**
 * The initiator's password sealed for Safaricom: RSA with PKCS#1 v1.5 padding (not OAEP) under
 * Safaricom's public certificate, then base64. Throws a readable error when the certificate is wrong.
 */
export function securityCredential(initiatorPassword: string, certificatePem: string): string {
  let key;
  try {
    key = createPublicKey(certificatePem.trim());
  } catch {
    throw new Error('The M-Pesa certificate could not be read. Paste the whole PEM certificate from Safaricom (it starts with -----BEGIN CERTIFICATE-----).');
  }
  return publicEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(initiatorPassword)).toString('base64');
}

/** 07XX, 01XX, 7XX, +254… and 254… all become 2547XXXXXXXX / 2541XXXXXXXX. Null when it cannot be a Kenyan mobile number. */
export function toMsisdn(raw: string | null | undefined): string | null {
  if (!has(raw)) return null;
  let d = String(raw).replace(/[^0-9]/g, '');
  if (d.startsWith('0')) d = `254${d.slice(1)}`;
  else if (d.length === 9 && /^[17]/.test(d)) d = `254${d}`;
  return /^254[17]\d{8}$/.test(d) ? d : null;
}

/** Two numbers are the same person's when their last nine digits agree (masked numbers never match). */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const da = (a ?? '').replace(/\D/g, '');
  const db = (b ?? '').replace(/\D/g, '');
  if (da.length < 9 || db.length < 9) return false;
  return da.slice(-9) === db.slice(-9);
}

/** "71", 71, "71.0", "1,000.50" -> cents. Null for anything that is not a plain amount. */
export function toCentsLoose(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim().replace(/,/g, '');
  const m = /^(-?)(\d+)(?:\.(\d*))?$/.exec(text);
  if (!m) return null;
  const frac = m[3] ?? '';
  if (/[1-9]/.test(frac.slice(2))) return null;
  const cents = Number(m[2]) * 100 + Number((`${frac  }00`).slice(0, 2));
  return has(m[1]) ? -cents : cents;
}

/** An M-Pesa receipt looks like NLJ7RT61SV: ten letters and digits. */
export const looksLikeReceipt = (s: string | null | undefined): boolean => typeof s === 'string' && /^[A-Z0-9]{10}$/.test(s);
