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

export interface NewsletterDraft {
  subject: string;
  body: string;
}

const MAX_SUBJECT = 150;
const MAX_BODY = 10_000;

/** What the company wants to send: a short subject and plain text. Markup is never sent as markup. */
export function parseNewsletterDraft(raw: unknown): { ok: true; value: NewsletterDraft } | { ok: false; error: string } {
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const subject = typeof input.subject === 'string' ? input.subject.replace(/\s+/g, ' ').trim() : '';
  const body = typeof input.body === 'string' ? input.body.replaceAll('\r\n', '\n').trim() : '';
  if (subject.length < 3) return { ok: false, error: 'Write a subject of at least 3 characters.' };
  if (subject.length > MAX_SUBJECT) return { ok: false, error: `The subject is too long (most ${String(MAX_SUBJECT)} characters).` };
  if (body.length < 10) return { ok: false, error: 'Write the message (at least 10 characters).' };
  if (body.length > MAX_BODY) return { ok: false, error: `The message is too long (most ${String(MAX_BODY)} characters).` };
  return { ok: true, value: { subject, body } };
}

/** Plain text made into paragraphs of HTML: every character escaped, blank lines between paragraphs, line breaks kept. */
export function newsletterBodyHtml(body: string): string {
  const escape = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  return body
    .split(/\n{2,}/)
    .map((paragraph) => `<p style="margin:0 0 14px">${escape(paragraph.trim()).replaceAll('\n', '<br>')}</p>`)
    .join('');
}
