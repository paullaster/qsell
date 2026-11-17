import { afterEach, describe, expect, it } from 'vitest';
import { businessDate, businessTimeZone, followBusinessTimeZone, formatBusinessTime } from './business-date';

describe('formatBusinessTime', () => {
  it('writes the instant in the business timezone, not the machine timezone', () => {
    const instant = new Date('2026-10-18T14:00:00.000Z');
    expect(formatBusinessTime(instant, 'Africa/Nairobi')).toBe('18 Oct 2026, 17:00');
    expect(formatBusinessTime(instant, 'UTC')).toBe('18 Oct 2026, 14:00');
  });
});

describe('the business time zone this process follows', () => {
  afterEach(() => followBusinessTimeZone('Africa/Nairobi'));

  it('starts as the built-in zone and follows the zone the company chose, for every date worked out without being told one', () => {
    expect(businessTimeZone()).toBe('Africa/Nairobi');
    // 22:30 UTC on 31 December is already New Year's Day in Nairobi, but not yet in London.
    const instant = new Date('2026-12-31T22:30:00.000Z');
    expect(businessDate(instant)).toBe('2027-01-01');
    followBusinessTimeZone('Europe/London');
    expect(businessTimeZone()).toBe('Europe/London');
    expect(businessDate(instant)).toBe('2026-12-31');
    expect(formatBusinessTime(instant)).toBe('31 Dec 2026, 22:30');
    followBusinessTimeZone('America/New_York');
    expect(businessDate(instant)).toBe('2026-12-31');
    expect(formatBusinessTime(instant)).toBe('31 Dec 2026, 17:30');
  });

  it('is told a zone explicitly, that wins over the one followed', () => {
    followBusinessTimeZone('Europe/London');
    expect(businessDate(new Date('2026-12-31T22:30:00.000Z'), 'Africa/Nairobi')).toBe('2027-01-01');
  });

  it('ignores a value that is not a usable zone, so a bad row never breaks every date', () => {
    followBusinessTimeZone('Europe/London');
    for (const bad of ['Mars/Olympus', '', 'EST', null, undefined, 7, {}]) {
      followBusinessTimeZone(bad);
      expect(businessTimeZone()).toBe('Europe/London');
    }
  });
});
