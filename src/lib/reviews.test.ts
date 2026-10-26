import { describe, expect, it } from 'vitest';
import { parseReviewInput, ratingSummary, reviewerDisplayName } from './reviews';

const good = { rating: 4, title: ' Lovely ', body: 'Works very well for us.' };

describe('parseReviewInput', () => {
  it('reads and trims a good review', () => {
    expect(parseReviewInput(good)).toEqual({ ok: true, value: { rating: 4, title: 'Lovely', body: 'Works very well for us.' } });
  });
  it.each([
    ['not an object', 'x', /could not be read/],
    ['no rating', { ...good, rating: undefined }, /rating/],
    ['half a star', { ...good, rating: 3.5 }, /rating/],
    ['six stars', { ...good, rating: 6 }, /rating/],
    ['rating as text', { ...good, rating: '5' }, /rating/],
    ['too short', { ...good, body: 'ok' }, /at least 10/],
    ['too long', { ...good, body: 'a'.repeat(2001) }, /2000/],
    ['long title', { ...good, title: 'a'.repeat(101) }, /title/],
    ['link in body', { ...good, body: 'Buy cheaper at www.example.com now' }, /links/],
    ['link in title', { ...good, title: 'see https://x.test' }, /links/],
  ])('refuses %s', (_name, input, message) => {
    const result = parseReviewInput(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(message);
  });
  it('removes control characters and keeps markup as plain text', () => {
    const result = parseReviewInput({ ...good, body: 'Great\u0000 <b>value</b> indeed' });
    expect(result).toMatchObject({ ok: true, value: { body: 'Great  <b>value</b> indeed' } });
  });
});

describe('reviewerDisplayName', () => {
  it('shows a first name and the last initial', () => {
    expect(reviewerDisplayName('Amina Wanjiru Kamau')).toBe('Amina K.');
    expect(reviewerDisplayName('Amina')).toBe('Amina');
  });
  it('never shows an email address and has a fallback', () => {
    expect(reviewerDisplayName('amina@example.com')).toBe('Customer');
    expect(reviewerDisplayName('   ')).toBe('Customer');
  });
});

describe('ratingSummary', () => {
  it('averages to one decimal and counts each star', () => {
    expect(ratingSummary([{ rating: 5, count: 2 }, { rating: 4, count: 1 }])).toEqual({
      average: 4.7,
      count: 3,
      distribution: [{ stars: 5, count: 2 }, { stars: 4, count: 1 }, { stars: 3, count: 0 }, { stars: 2, count: 0 }, { stars: 1, count: 0 }],
    });
  });
  it('is zero with no reviews', () => {
    expect(ratingSummary([])).toMatchObject({ average: 0, count: 0 });
  });
});
