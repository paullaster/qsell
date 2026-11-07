import { describe, expect, it } from 'vitest';
import { addDays, checkSlot, daysFrom, instantOf, isDay, nairobiDay, unavailable, weekdayOf, weekdaysWords, windowOf, type SlotRule } from './delivery-slot';

const rule: SlotRule = { weekdays: [1, 2, 3, 4, 5], startsAt: '09:00', endsAt: '12:00', capacity: 2, cutoffMinutes: 120, isActive: true };
// Thursday 2026-11-05, 06:00 in Nairobi.
const now = new Date('2026-11-05T03:00:00Z');

describe('days in Nairobi', () => {
  it('know their weekday, add days and read an instant as a Nairobi day', () => {
    expect(weekdayOf('2026-11-05')).toBe(4);
    expect(weekdayOf('2026-11-08')).toBe(7);
    expect(addDays('2026-11-30', 2)).toBe('2026-12-02');
    expect(nairobiDay(new Date('2026-11-05T21:30:00Z'))).toBe('2026-11-06');
    expect(instantOf('2026-11-05', '09:00').toISOString()).toBe('2026-11-05T06:00:00.000Z');
    expect(isDay('2026-02-30')).toBe(false);
    expect(isDay('2026-11-05')).toBe(true);
    expect(daysFrom('2026-11-05', 3)).toEqual(['2026-11-05', '2026-11-06', '2026-11-07']);
    expect(daysFrom('2026-11-05', 99)).toHaveLength(14);
  });
});

describe('a slot as typed', () => {
  it('is accepted with a name, days, window, room and cut-off', () => {
    expect(checkSlot({ name: ' Morning ', weekdays: [3, 1, 1], startsAt: '09:00', endsAt: '12:00', capacity: 5, cutoffMinutes: 60 })).toEqual({ ok: true, value: { name: 'Morning', weekdays: [1, 3], startsAt: '09:00', endsAt: '12:00', capacity: 5, cutoffMinutes: 60 } });
  });

  it('is refused when something is missing or does not make sense', () => {
    const good = { name: 'Morning', weekdays: [1], startsAt: '09:00', endsAt: '12:00', capacity: 5, cutoffMinutes: 60 };
    const bad: Record<string, unknown>[] = [{ name: 'M' }, { weekdays: [] }, { weekdays: [8] }, { weekdays: ['1'] }, { startsAt: '9am' }, { endsAt: '08:00' }, { endsAt: '09:00' }, { capacity: 0 }, { capacity: 2.5 }, { capacity: 20_000 }, { cutoffMinutes: -1 }, { cutoffMinutes: 99_999 }];
    for (const change of bad) expect(checkSlot({ ...good, ...change })).toMatchObject({ ok: false });
  });
});

describe('when a slot can be booked', () => {
  it('can, on a day it runs, in time, with room', () => {
    expect(unavailable(rule, '2026-11-06', now, 1, null)).toBeNull();
    expect(windowOf('2026-11-06', rule).start.toISOString()).toBe('2026-11-06T06:00:00.000Z');
  });

  it('cannot when stopped, on the wrong day, in the past, too far ahead or on a closed day', () => {
    expect(unavailable({ ...rule, isActive: false }, '2026-11-06', now, 0, null)).toBe('stopped');
    expect(unavailable(rule, '2026-11-07', now, 0, null)).toBe('wrong_day');
    expect(unavailable(rule, '2026-11-04', now, 0, null)).toBe('past');
    expect(unavailable(rule, '2027-03-01', now, 0, null)).toBe('too_far');
    expect(unavailable(rule, '2026-11-06', now, 0, 'Public holiday')).toBe('closed');
  });

  it('closes a cut-off before the slot starts, and is full at its capacity', () => {
    // The slot starts at 09:00 on the 5th; with two hours of cut-off it closes at 07:00. It is 06:00 now.
    expect(unavailable(rule, '2026-11-05', now, 0, null)).toBeNull();
    expect(unavailable(rule, '2026-11-05', new Date('2026-11-05T04:30:00Z'), 0, null)).toBe('cut_off');
    expect(unavailable(rule, '2026-11-06', now, 2, null)).toBe('full');
    expect(unavailable(rule, '2026-11-06', now, 3, null)).toBe('full');
  });

  it('says its weekdays in words', () => {
    expect(weekdaysWords([1, 2, 3, 4, 5])).toBe('Weekdays');
    expect(weekdaysWords([7, 6])).toBe('Weekends');
    expect(weekdaysWords([1, 2, 3, 4, 5, 6, 7])).toBe('Every day');
    expect(weekdaysWords([5, 1])).toBe('Mon, Fri');
  });
});
