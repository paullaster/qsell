import { describe, expect, it } from 'vitest';
import { encodeCursor } from '@/server/domains/lookups/request';
import {
  parseTemplateListRequest,
  TEMPLATE_LIST_DEFAULT_LIMIT,
  TEMPLATE_LIST_MAX_LIMIT,
} from './template-list';

const ok = (raw: unknown) => {
  const parsed = parseTemplateListRequest(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};
const bad = (raw: unknown) => {
  const parsed = parseTemplateListRequest(raw);
  if (parsed.ok) throw new Error('expected a rejection');
  return parsed.error;
};

describe('parsing a template list request', () => {
  it('fills the defaults', () => {
    expect(ok(undefined)).toEqual({
      query: '',
      status: 'all',
      limit: TEMPLATE_LIST_DEFAULT_LIMIT,
      after: null,
    });
  });

  it('accepts all, active and archived only', () => {
    for (const status of ['all', 'active', 'archived']) expect(ok({ status }).status).toBe(status);
    for (const status of ['draft', 'ACTIVE', 1, null]) {
      expect(bad({ status })).toMatch(/Unknown status/);
    }
  });

  it('cleans and limits search text and page size', () => {
    expect(ok({ query: ' pack\u0007 ' }).query).toBe('pack');
    expect(bad({ query: 'x'.repeat(101) })).toMatch(/limited/);
    expect(ok({ limit: 9999 }).limit).toBe(TEMPLATE_LIST_MAX_LIMIT);
    for (const limit of [0, 2.5, '5']) expect(bad({ limit })).toMatch(/page size/);
  });

  it('takes a cursor it issued and nothing else', () => {
    const cursor = encodeCursor({ k: '2026-10-14 10:00:00+03', id: 'x' });
    expect(ok({ cursor }).after).toEqual({ k: '2026-10-14 10:00:00+03', id: 'x' });
    expect(bad({ cursor: 'nonsense!' })).toMatch(/cursor/);
    expect(bad('x')).toMatch(/Invalid list request/);
  });
});
