const SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A subscriber's email as stored: trimmed and lower-case. Null when it is not one. */
export function newsletterEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  return email.length >= 3 && email.length <= 254 && SHAPE.test(email) ? email : null;
}

/** A confirmation or unsubscribe token as it arrives in an address: 43 characters of base64url, nothing else. */
export const isNewsletterToken = (raw: unknown): raw is string => typeof raw === 'string' && /^[A-Za-z0-9_-]{43}$/.test(raw);

/** One CSV cell, safe to open in a spreadsheet: quoted, and a leading = + - @ made harmless so it cannot run as a formula. */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
