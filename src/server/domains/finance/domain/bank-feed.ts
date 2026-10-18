import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { finish, parseMoney, type ParsedLine, type ParsedStatement } from './bank-statement';

import { emptyToNull, isRecord } from '@/lib/values';

/**
 * Statement lines pushed to us by a bank, an aggregator or a script. Nothing in the body is trusted: every line is checked and
 * a delivery with any bad line is refused whole, with the line named. Pure.
 */
export const MAX_FEED_LINES = 5000;
export const MAX_FEED_BYTES = 5 * 1024 * 1024;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function realDate(s: string): boolean {
  if (!DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const text = (v: unknown, max: number): string | null | undefined => {
  if (v === undefined || v === null) return null;
  return typeof v === 'string' && v.length <= max ? v.replace(/\s+/g, ' ').trim() : undefined;
};

const money = (v: unknown): number | null => (typeof v === 'string' || typeof v === 'number' ? parseMoney(String(v)) : null);

export interface FeedParse {
  statement: ParsedStatement;
  /** The same delivery sent twice has the same fingerprint, so it is recognised as a repeat. */
  fingerprint: string;
}

export function parseFeedPayload(body: unknown): FeedParse | { error: string } {
  if (!isRecord(body)) return { error: 'The body must be a JSON object with a "lines" list.' };
  const raw = body.lines;
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'The body must have a "lines" list with at least one line.' };
  if (raw.length > MAX_FEED_LINES) return { error: `At most ${String(MAX_FEED_LINES)} lines can be sent at once.` };
  const lines: ParsedLine[] = [];
  const errors: { row: number; message: string }[] = [];
  raw.forEach((item: unknown, i: number) => {
    const n = i + 1;
    if (!isRecord(item)) return void errors.push({ row: n, message: `Line ${String(n)} is not an object.` });
    const date = typeof item.date === 'string' ? item.date : '';
    const cents = money(item.amount);
    const description = text(item.description, 1000);
    const reference = text(item.reference, 200);
    const counterparty = text(item.counterparty, 200);
    const balance = item.balance === undefined || item.balance === null ? null : money(item.balance);
    if (!realDate(date)) return void errors.push({ row: n, message: `Line ${String(n)}: the date must be written YYYY-MM-DD.` });
    if (cents === null || cents === 0) return void errors.push({ row: n, message: `Line ${String(n)}: the amount must be a non-zero number with at most 2 decimals (negative for money out).` });
    if (description === undefined || reference === undefined || counterparty === undefined) return void errors.push({ row: n, message: `Line ${String(n)}: a text is too long or is not text.` });
    if (item.balance !== undefined && item.balance !== null && balance === null) return void errors.push({ row: n, message: `Line ${String(n)}: the balance could not be read.` });
    lines.push({ lineNo: 0, date, description: description ?? '', reference: emptyToNull(reference), counterparty: emptyToNull(counterparty), amountCents: cents, balanceCents: balance });
  });
  const opening = body.openingBalance === undefined || body.openingBalance === null ? null : money(body.openingBalance);
  const closing = body.closingBalance === undefined || body.closingBalance === null ? null : money(body.closingBalance);
  if (body.openingBalance !== undefined && body.openingBalance !== null && opening === null) errors.push({ row: 0, message: 'The opening balance could not be read.' });
  if (body.closingBalance !== undefined && body.closingBalance !== null && closing === null) errors.push({ row: 0, message: 'The closing balance could not be read.' });
  if (errors.length > 0) return { error: errors.slice(0, 5).map((e) => e.message).join(' ') + (errors.length > 5 ? ` (and ${String(errors.length - 5)} more)` : '') };
  const done = finish(lines, [], [], []);
  const statement: ParsedStatement = { ...done, openingCents: opening ?? done.openingCents, closingCents: closing ?? done.closingCents };
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ lines: statement.lines.map((l) => [l.date, l.amountCents, l.reference, l.description, l.counterparty, l.balanceCents]), o: statement.openingCents, c: statement.closingCents }))
    .digest('hex');
  return { statement, fingerprint };
}

/** A new secret for a feed's address: 256 random bits, URL-safe. Shown once; only its fingerprint is kept. */
export const newFeedSecret = (): string => randomBytes(32).toString('base64url');

export const feedSecretHash = (secret: string): string => createHash('sha256').update(secret, 'utf8').digest('hex');

/** The secret in an address against the kept fingerprint, in time that does not depend on how much of it matched. */
export function feedSecretMatches(secret: string, hash: string): boolean {
  const given = Buffer.from(feedSecretHash(secret), 'hex');
  const kept = Buffer.from(hash, 'hex');
  return given.length === kept.length && timingSafeEqual(given, kept);
}
