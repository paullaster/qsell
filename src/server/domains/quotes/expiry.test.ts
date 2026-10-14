import { describe, expect, it } from 'vitest';
import { isQuoteExpired } from './expiry';

const now = new Date('2026-10-14T12:00:00Z');
const past = new Date('2026-10-01T00:00:00Z');
const future = new Date('2026-11-01T00:00:00Z');

describe('when a quote counts as expired', () => {
  it('is expired when past its date and still open', () => {
    for (const status of ['draft', 'pending_approval', 'approved', 'sent', 'accepted']) {
      expect(isQuoteExpired({ validUntil: past, status }, now)).toBe(true);
    }
  });
  it('is not expired before its date, or with no date', () => {
    expect(isQuoteExpired({ validUntil: future, status: 'sent' }, now)).toBe(false);
    expect(isQuoteExpired({ validUntil: null, status: 'sent' }, now)).toBe(false);
  });
  it('is never expired once converted, rejected or cancelled', () => {
    for (const status of ['converted', 'rejected', 'cancelled']) {
      expect(isQuoteExpired({ validUntil: past, status }, now)).toBe(false);
    }
  });
  it('the moment itself is not yet expired', () => {
    expect(isQuoteExpired({ validUntil: now, status: 'sent' }, now)).toBe(false);
  });
});
