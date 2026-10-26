import { describe, expect, it } from 'vitest';
import { csvCell, isNewsletterToken, newsletterEmail } from './newsletter';

describe('newsletterEmail', () => {
  it('trims and lower-cases a good address', () => expect(newsletterEmail('  Amina@Example.COM ')).toBe('amina@example.com'));
  it.each(['', 'a', 'no-at.com', 'a@b', 'a b@c.d', 'a@b@c.d', `${'a'.repeat(250)}@x.co`, 7, null])('refuses %s', (value) => expect(newsletterEmail(value)).toBeNull());
});

describe('isNewsletterToken', () => {
  it('takes only 43 base64url characters', () => {
    expect(isNewsletterToken('A'.repeat(43))).toBe(true);
    for (const bad of ['', 'A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}!`, `${'A'.repeat(42)}/`, undefined, 5]) expect(isNewsletterToken(bad)).toBe(false);
  });
});

describe('csvCell', () => {
  it('quotes and doubles quotes', () => expect(csvCell('a"b')).toBe('"a""b"'));
  it('neutralises spreadsheet formulas', () => {
    for (const bad of ['=1+1', '+1', '-1', '@SUM(A1)']) expect(csvCell(bad)).toBe(`"'${bad}"`);
  });
});
