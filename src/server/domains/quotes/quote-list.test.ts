import { describe, expect, it } from 'vitest';
import { encodeCursor } from '@/server/domains/lookups/request';
import {
  parseQuoteListRequest,
  QUOTE_LIST_DEFAULT_LIMIT,
  QUOTE_LIST_MAX_LIMIT,
} from './quote-list';

const ok = (raw: unknown) => {
  const parsed = parseQuoteListRequest(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};
const bad = (raw: unknown) => {
  const parsed = parseQuoteListRequest(raw);
  if (parsed.ok) throw new Error('expected a rejection');
  return parsed.error;
};

describe('parsing a quotes list request', () => {
  it('fills the defaults, also from nothing at all', () => {
    const expected = { query: '', status: 'all', limit: QUOTE_LIST_DEFAULT_LIMIT, after: null };
    expect(ok({})).toEqual(expected);
    expect(ok(undefined)).toEqual(expected);
    expect(ok(null)).toEqual(expected);
  });

  it('accepts the statuses the list offers and nothing else', () => {
    for (const status of ['all', 'draft', 'pending_approval', 'expired', 'cancelled']) {
      expect(ok({ status }).status).toBe(status);
    }
    for (const status of ['DRAFT', 'x', 5, null, '']) {
      expect(bad({ status })).toMatch(/Unknown status/);
    }
  });

  it('cleans and limits the search text', () => {
    expect(ok({ query: '  QTE-1\u0000 ' }).query).toBe('QTE-1');
    expect(bad({ query: 'x'.repeat(101) })).toMatch(/limited to 100/);
    expect(bad({ query: 5 })).toMatch(/search text/);
  });

  it('caps the page size and rejects nonsense sizes', () => {
    expect(ok({ limit: 5000 }).limit).toBe(QUOTE_LIST_MAX_LIMIT);
    expect(ok({ limit: 10 }).limit).toBe(10);
    for (const limit of [0, -3, 1.5, '10', Number.NaN]) {
      expect(bad({ limit })).toMatch(/page size/);
    }
  });

  it('takes a cursor it issued and rejects any other', () => {
    const cursor = encodeCursor({ k: '2026-10-14 10:00:00.123456+03', id: 'abc' });
    expect(ok({ cursor }).after).toEqual({ k: '2026-10-14 10:00:00.123456+03', id: 'abc' });
    for (const bogus of ['!!!', 5, {}, 'x'.repeat(700)]) {
      expect(bad({ cursor: bogus })).toMatch(/cursor/);
    }
  });

  it('rejects anything that is not an object', () => {
    for (const raw of ['x', 5, [], [{}]]) expect(bad(raw)).toMatch(/Invalid list request/);
  });
});
