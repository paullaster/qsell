import { afterEach, describe, expect, it, vi } from 'vitest';
import { today } from './ui';

afterEach(() => vi.useRealTimers());

describe('today', () => {
  it('is the business day in Nairobi, not the UTC day', () => {
    vi.useFakeTimers();
    // 21:30 UTC on the 14th is 00:30 on the 15th in Nairobi.
    vi.setSystemTime(new Date('2026-10-14T21:30:00Z'));
    expect(today()).toBe('2026-10-15');
    vi.setSystemTime(new Date('2026-10-14T20:59:00Z'));
    expect(today()).toBe('2026-10-14');
  });
});
