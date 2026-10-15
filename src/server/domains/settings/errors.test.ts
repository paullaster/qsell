import { describe, expect, it } from 'vitest';
import { isMalformedId, isUniqueViolation, NO_SUCH_RECORD } from './errors';

describe('database refusals read as words', () => {
  it('knows an address that names no possible record (a malformed id), also when the driver wraps it', () => {
    expect(isMalformedId({ code: '22P02' })).toBe(true);
    expect(isMalformedId({ cause: { code: '22P02' } })).toBe(true);
    expect(isMalformedId({ code: '23505' })).toBe(false);
    expect(isMalformedId(new Error('boom'))).toBe(false);
    expect(isMalformedId(null)).toBe(false);
  });

  it('answers such an address as a missing record', () => {
    expect(NO_SUCH_RECORD).toEqual({ ok: false, error: 'That record does not exist.', code: 'NOT_FOUND' });
  });

  it('still tells a duplicate from anything else', () => {
    expect(isUniqueViolation({ cause: { code: '23505' } })).toBe(true);
    expect(isUniqueViolation({ code: '22P02' })).toBe(false);
  });
});
