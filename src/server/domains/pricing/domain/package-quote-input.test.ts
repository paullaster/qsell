import { describe, expect, it } from 'vitest';
import { isCalendarDay, parseQuoteRequest } from './package-quote-input';

const base = { productId: 'p1', servings: 12, picks: [{ slotId: 's', optionId: 'o', count: 1 }] };

describe('reading a quote request', () => {
  it('needs a name and a way to answer from a guest', () => {
    expect(parseQuoteRequest({ ...base, email: 'a@b.co' }, true)).toEqual({ ok: false, error: 'Please tell us your name.' });
    expect(parseQuoteRequest({ ...base, name: 'Wanjiru' }, true)).toEqual({ ok: false, error: 'Give an email address or a phone number so we can send the quote.' });
    const ok = parseQuoteRequest({ ...base, name: ' Wanjiru ', email: 'WANJIRU@Example.com', neededOn: '2030-05-04', message: ' for 12 ' }, true);
    expect(ok.ok && ok.input).toMatchObject({ name: 'Wanjiru', email: 'wanjiru@example.com', neededOn: '2030-05-04', message: 'for 12', phone: '' });
  });

  it('lets a signed-in shopper leave the details blank (the server fills them from the account)', () => {
    expect(parseQuoteRequest(base, false).ok).toBe(true);
  });

  it('refuses a bad email, phone or date', () => {
    expect(parseQuoteRequest({ ...base, name: 'A', email: 'nope' }, true)).toEqual({ ok: false, error: 'That email address does not look right.' });
    expect(parseQuoteRequest({ ...base, name: 'A', phone: 'abc' }, true)).toEqual({ ok: false, error: 'That phone number does not look right.' });
    expect(parseQuoteRequest({ ...base, name: 'A', phone: '0712 345 678', neededOn: '2030-02-31' }, true)).toEqual({ ok: false, error: 'That is not a date.' });
  });

  it('refuses what is not a request, and unreadable choices', () => {
    expect(parseQuoteRequest(null, true).ok).toBe(false);
    expect(parseQuoteRequest({ name: 'A', email: 'a@b.co' }, true)).toEqual({ ok: false, error: 'Your choices could not be read.' });
  });

  it('bounds the long fields', () => {
    const r = parseQuoteRequest({ ...base, name: 'A'.repeat(500), email: 'a@b.co', message: 'x'.repeat(5000) }, true);
    expect(r.ok && [r.input.name.length, r.input.message.length]).toEqual([120, 1000]);
  });

  it('knows a real calendar day', () => {
    expect(isCalendarDay('2028-02-29')).toBe(true);
    expect(isCalendarDay('2027-02-29')).toBe(false);
    expect(isCalendarDay('tomorrow')).toBe(false);
  });
});
