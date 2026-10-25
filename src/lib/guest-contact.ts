/** The email on a checkout is optional; when given it must look like one. Blank is stored as an empty string. Pure. */
export type OptionalEmail = { ok: true; email: string } | { ok: false; error: string };

const SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function readOptionalEmail(raw: string | null | undefined): OptionalEmail {
  const email = (raw ?? '').trim().toLowerCase();
  if (email === '') return { ok: true, email };
  if (email.length > 254 || !SHAPE.test(email)) return { ok: false, error: 'Enter a valid email address, or leave it blank.' };
  return { ok: true, email };
}
