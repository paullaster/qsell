import { describe, expect, it } from 'vitest';
import { readOptionalEmail } from './guest-contact';

describe('readOptionalEmail', () => {
  it('accepts blank and whitespace as no email', () => {
    expect(readOptionalEmail('')).toEqual({ ok: true, email: '' });
    expect(readOptionalEmail('   ')).toEqual({ ok: true, email: '' });
    expect(readOptionalEmail(undefined)).toEqual({ ok: true, email: '' });
  });
  it('trims and lower-cases a good address', () => {
    expect(readOptionalEmail('  Jane@Example.COM ')).toEqual({ ok: true, email: 'jane@example.com' });
  });
  it('refuses something that is not an address', () => {
    for (const bad of ['jane', 'jane@', '@x.co', 'a b@x.co', 'a@b']) {
      expect(readOptionalEmail(bad).ok).toBe(false);
    }
  });
});
