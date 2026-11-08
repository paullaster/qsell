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

describe('a newsletter to send', () => {
  it('needs a subject and a message of sensible size', async () => {
    const { parseNewsletterDraft } = await import('./newsletter');
    expect(parseNewsletterDraft({ subject: ' Eid   offers ', body: 'Dear friend,\r\nTen percent off.' })).toEqual({ ok: true, value: { subject: 'Eid offers', body: 'Dear friend,\nTen percent off.' } });
    expect(parseNewsletterDraft({ subject: 'x', body: 'long enough text' }).ok).toBe(false);
    expect(parseNewsletterDraft({ subject: 'Hello', body: 'short' }).ok).toBe(false);
    expect(parseNewsletterDraft({ subject: 'x'.repeat(151), body: 'long enough text' }).ok).toBe(false);
    expect(parseNewsletterDraft({ subject: 'Hello', body: 'y'.repeat(10_001) }).ok).toBe(false);
    expect(parseNewsletterDraft(null).ok).toBe(false);
  });
  it('is sent as text: markup is escaped and paragraphs are kept', async () => {
    const { newsletterBodyHtml } = await import('./newsletter');
    expect(newsletterBodyHtml('Hi <b>you</b>\nline two\n\nSecond & last')).toBe('<p style="margin:0 0 14px">Hi &lt;b&gt;you&lt;/b&gt;<br>line two</p><p style="margin:0 0 14px">Second &amp; last</p>');
  });
});
