import type { PackageLineInput } from './package-shop';
import { parsePackageLine } from './package-shop-input';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PHONE = /^\+?[0-9][0-9 \-()]{6,18}$/;

/** What the shopper typed on the "Request a quote" form, after it has been read (never trusted: the server prices and checks the line). */
export interface QuoteRequestInput {
  line: PackageLineInput;
  name: string;
  email: string;
  phone: string;
  /** The day the food or service is needed (`YYYY-MM-DD`), or empty. */
  neededOn: string;
  /** What the shopper wants us to know (who it is for, the occasion), or empty. */
  message: string;
}

export type ParsedQuoteRequest = { ok: true; input: QuoteRequestInput } | { ok: false; error: string };

const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** True for a real calendar day written `YYYY-MM-DD`. */
export const isCalendarDay = (day: string): boolean => DAY.test(day) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;

/**
 * Reads a quote request. A name is needed, and a way to answer: an email address or a phone number. A signed-in shopper's blanks are
 * filled from their account by the caller, so `requireContact` is off for them.
 */
export function parseQuoteRequest(raw: unknown, requireContact: boolean): ParsedQuoteRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'Your request could not be read.' };
  const r = raw as Record<string, unknown>;
  const line = parsePackageLine(r);
  if (line === null) return { ok: false, error: 'Your choices could not be read.' };
  const name = text(r.name, 120);
  const email = text(r.email, 160).toLowerCase();
  const phone = text(r.phone, 24);
  const neededOn = text(r.neededOn, 10);
  const message = text(r.message, 1000);
  if (requireContact && name === '') return { ok: false, error: 'Please tell us your name.' };
  if (email !== '' && !EMAIL.test(email)) return { ok: false, error: 'That email address does not look right.' };
  if (phone !== '' && !PHONE.test(phone)) return { ok: false, error: 'That phone number does not look right.' };
  if (requireContact && email === '' && phone === '') return { ok: false, error: 'Give an email address or a phone number so we can send the quote.' };
  if (neededOn !== '' && !isCalendarDay(neededOn)) return { ok: false, error: 'That is not a date.' };
  return { ok: true, input: { line, name, email, phone, neededOn, message } };
}
