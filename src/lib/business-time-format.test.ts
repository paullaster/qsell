import { describe, expect, it } from 'vitest';
import { dateIn, dayOf, whenIn, whenOrBlank } from './business-time-format';

describe('writing an instant for people in the business zone', () => {
  it('writes the date and time in the zone given, not the machine\'s', () => {
    const at = '2026-10-18T14:00:00.000Z';
    expect(whenIn(at, 'Africa/Nairobi')).toBe('18 Oct 2026, 17:00');
    expect(whenIn(at, 'UTC')).toBe('18 Oct 2026, 14:00');
    expect(whenIn(at, 'Asia/Tokyo')).toBe('18 Oct 2026, 23:00');
    // Near midnight the day itself changes with the zone.
    expect(whenIn('2026-12-31T22:30:00.000Z', 'Africa/Nairobi')).toBe('1 Jan 2027, 01:30');
    expect(whenIn('2026-12-31T22:30:00.000Z', 'America/New_York')).toBe('31 Dec 2026, 17:30');
  });

  it('writes nothing for a missing time', () => {
    expect(whenOrBlank(null, 'UTC')).toBe('');
    expect(whenOrBlank(undefined, 'UTC')).toBe('');
    expect(whenOrBlank('', 'UTC')).toBe('');
    expect(whenOrBlank('2026-10-14T10:00:00Z', 'Africa/Nairobi')).toBe('14 Oct 2026, 13:00');
  });

  it('writes the date an instant falls on in the zone, which can differ from the machine\'s', () => {
    expect(dateIn('2026-12-31T22:30:00.000Z', 'Africa/Nairobi')).toBe('1 Jan 2027');
    expect(dateIn('2026-12-31T22:30:00.000Z', 'America/New_York')).toBe('31 Dec 2026');
  });

  it('writes a plain day the same wherever the business is', () => {
    expect(dayOf('2026-11-06')).toBe('Fri 6 Nov');
    expect(dayOf('2027-01-01')).toBe('Fri 1 Jan');
  });
});
