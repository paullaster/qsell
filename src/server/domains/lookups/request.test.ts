import { describe, expect, it } from 'vitest';
import { cleanQuery, decodeCursor, encodeCursor, escapeLike, parseLookupRequest } from './request';

const ok = (raw: unknown) => {
  const parsed = parseLookupRequest(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};
const bad = (raw: unknown) => {
  const parsed = parseLookupRequest(raw);
  if (parsed.ok) throw new Error('expected a rejection');
  return parsed.error;
};

describe('parsing a lookup request from the browser', () => {
  it('fills the defaults', () => {
    expect(ok({ source: 'quote-templates' })).toEqual({
      source: 'quote-templates',
      query: '',
      limit: 20,
      after: null,
      filters: {},
    });
  });

  it('caps the page size and rejects nonsense sizes', () => {
    expect(ok({ source: 'a', limit: 5000 }).limit).toBe(50);
    expect(ok({ source: 'a', limit: 7 }).limit).toBe(7);
    for (const limit of [0, -1, 1.5, '20', Number.NaN, null]) {
      expect(bad({ source: 'a', limit })).toMatch(/page size/);
    }
  });

  it('rejects anything that is not a plain request object', () => {
    for (const raw of [null, undefined, 'x', 5, [], [{ source: 'a' }]]) {
      expect(bad(raw)).toMatch(/Invalid lookup request/);
    }
  });

  it('only accepts a well-formed source key', () => {
    for (const source of [undefined, 1, '', 'Quote', 'a b', '../etc', 'a;drop', 'x'.repeat(80)]) {
      expect(bad({ source })).toMatch(/Unknown list/);
    }
    expect(ok({ source: 'section-templates' }).source).toBe('section-templates');
  });

  it('cleans and limits the search text', () => {
    expect(ok({ source: 'a', query: '  rice\u0000\n5kg ' }).query).toBe('rice  5kg');
    expect(bad({ source: 'a', query: 'x'.repeat(101) })).toMatch(/limited to 100/);
    expect(bad({ source: 'a', query: 5 })).toMatch(/search text/);
  });

  it('decodes a cursor it issued and rejects any other', () => {
    const cursor = encodeCursor({ k: 'Pack 5kg', id: 'abc' });
    expect(ok({ source: 'a', cursor }).after).toEqual({ k: 'Pack 5kg', id: 'abc' });
    expect(ok({ source: 'a', cursor: null }).after).toBeNull();
    for (const c of ['!!!', 'e30', Buffer.from('[1]').toString('base64url'), 5, 'x'.repeat(700)]) {
      expect(bad({ source: 'a', cursor: c })).toMatch(/cursor/);
    }
    expect(decodeCursor(Buffer.from('{"k":1,"id":"a"}').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('{"k":"a","id":""}').toString('base64url'))).toBeNull();
  });

  it('accepts only a few short string filters', () => {
    expect(ok({ source: 'a', filters: { status: 'active' } }).filters).toEqual({
      status: 'active',
    });
    expect(bad({ source: 'a', filters: { status: 1 } })).toMatch(/filters/);
    expect(bad({ source: 'a', filters: ['x'] })).toMatch(/filters/);
    expect(bad({ source: 'a', filters: { 'Bad Name': 'x' } })).toMatch(/filters/);
    expect(bad({ source: 'a', filters: { status: 'x'.repeat(101) } })).toMatch(/filters/);
    const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`f${i}`, 'v']));
    expect(bad({ source: 'a', filters: many })).toMatch(/Too many/);
  });
});

describe('escaping search text for LIKE', () => {
  it('makes wildcards literal', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
    expect(escapeLike('plain')).toBe('plain');
  });
  it('cleanQuery strips control characters', () => {
    expect(cleanQuery('a\u0007b')).toBe('a b');
  });
});
