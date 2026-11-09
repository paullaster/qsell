import { describe, expect, it } from 'vitest';
import { addDays, checkLead, checkSlot, earliestReady, leadWords, dayWords, daysFrom, instantOf, isDay, nairobiDay, shopOffer, unavailable, weekdayOf, weekdaysWords, windowOf, type SlotRule } from './delivery-slot';

const rule: SlotRule = { weekdays: [1, 2, 3, 4, 5], startsAt: '09:00', endsAt: '12:00', capacity: 2, cutoffMinutes: 120, maxWeightKg: null, isActive: true };
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
    expect(checkSlot({ name: ' Morning ', weekdays: [3, 1, 1], startsAt: '09:00', endsAt: '12:00', capacity: 5, cutoffMinutes: 60 })).toEqual({ ok: true, value: { name: 'Morning', weekdays: [1, 3], startsAt: '09:00', endsAt: '12:00', capacity: 5, cutoffMinutes: 60, maxWeightKg: null } });
    expect(checkSlot({ name: 'Heavy', weekdays: [1], startsAt: '09:00', endsAt: '12:00', capacity: 5, cutoffMinutes: 60, maxWeightKg: 250.5 })).toMatchObject({ ok: true, value: { maxWeightKg: 250.5 } });
    expect(checkSlot({ name: 'Heavy', weekdays: [1], startsAt: '09:00', endsAt: '12:00', capacity: 5, cutoffMinutes: 60, maxWeightKg: '' })).toMatchObject({ ok: true, value: { maxWeightKg: null } });
  });

  it('is refused when something is missing or does not make sense', () => {
    const good = { name: 'Morning', weekdays: [1], startsAt: '09:00', endsAt: '12:00', capacity: 5, cutoffMinutes: 60 };
    const bad: Record<string, unknown>[] = [{ name: 'M' }, { weekdays: [] }, { weekdays: [8] }, { weekdays: ['1'] }, { startsAt: '9am' }, { endsAt: '08:00' }, { endsAt: '09:00' }, { capacity: 0 }, { capacity: 2.5 }, { capacity: 20_000 }, { cutoffMinutes: -1 }, { cutoffMinutes: 99_999 }, { maxWeightKg: 0 }, { maxWeightKg: -5 }, { maxWeightKg: 'heavy' }, { maxWeightKg: 1.234 }, { maxWeightKg: 2_000_000 }];
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

describe('weight and lead times', () => {
  it('stops a slot taking more than it can carry in a day, to the gram, and lets a delivery that fits in', () => {
    const limited: SlotRule = { ...rule, maxWeightKg: 100 };
    expect(unavailable(limited, '2026-11-06', now, 0, null, { weight: { kg: 40, takenKg: 60 } })).toBeNull();
    expect(unavailable(limited, '2026-11-06', now, 0, null, { weight: { kg: 40.01, takenKg: 60 } })).toBe('too_heavy');
    expect(unavailable(limited, '2026-11-06', now, 0, null, { weight: { kg: 150, takenKg: 0 } })).toBe('too_heavy');
    // No limit set, or no delivery to weigh: weight does not matter.
    expect(unavailable(rule, '2026-11-06', now, 0, null, { weight: { kg: 5000, takenKg: 0 } })).toBeNull();
    expect(unavailable(limited, '2026-11-06', now, 0, null)).toBeNull();
    // Full comes before heavy.
    expect(unavailable(limited, '2026-11-06', now, 2, null, { weight: { kg: 1, takenKg: 0 } })).toBe('full');
  });

  it('keeps a slot from starting before the goods can be ready', () => {
    const early = new Date('2026-11-06T07:00:00Z');
    expect(unavailable(rule, '2026-11-06', now, 0, null, { earliest: early })).toBe('too_soon');
    expect(unavailable(rule, '2026-11-06', now, 0, null, { earliest: new Date('2026-11-06T06:00:00Z') })).toBeNull();
    expect(unavailable(rule, '2026-11-06', now, 0, null, { earliest: null })).toBeNull();
  });

  it('works out when the goods are ready from the longest lead time, and says which held them', () => {
    const ordered = new Date('2026-11-05T06:00:00Z');
    expect(earliestReady(ordered, [])).toEqual({ at: ordered, by: null });
    expect(earliestReady(ordered, [{ label: 'Standard handling', minutes: 30 }, { label: 'Frozen fish', minutes: 180 }, { label: 'Rural zone', minutes: 120 }])).toEqual({ at: new Date('2026-11-05T09:00:00Z'), by: 'Frozen fish' });
    expect(earliestReady(ordered, [{ label: 'None', minutes: 0 }])).toEqual({ at: ordered, by: null });
  });

  it('says a lead time in words and checks one as typed', () => {
    expect(leadWords(1)).toBe('1 minute');
    expect(leadWords(45)).toBe('45 minutes');
    expect(leadWords(120)).toBe('2 hours');
    expect(leadWords(1620)).toBe('1 day 3 hours');
    expect(leadWords(90)).toBe('1 hour 30 min');
    expect(checkLead(120, ' Fresh fish ')).toEqual({ ok: true, minutes: 120, note: 'Fresh fish' });
    expect(checkLead(60, '')).toEqual({ ok: true, minutes: 60, note: null });
    for (const bad of [0, -5, 1.5, 'two hours', 50_000, null]) expect(checkLead(bad, null)).toMatchObject({ ok: false });
    expect(checkLead(60, 'x'.repeat(201))).toMatchObject({ ok: false });
  });
});

describe('what a shopper is offered', () => {
  const slot = (id: string, available: boolean, why: string | null = null) => ({ slotId: id, name: 'Morning', startsAt: '09:00', endsAt: '12:00', available, why });
  it('reads a day the way a shopper does', () => {
    expect(dayWords('2026-11-06')).toBe('Fri 6 Nov');
  });
  it('leaves out days with no deliveries and names the first time that is free', () => {
    const offer = shopOffer([
      { day: '2026-11-06', closedReason: 'Public holiday', slots: [slot('a', true)] },
      { day: '2026-11-07', closedReason: null, slots: [slot('b', false, 'This slot is full.')] },
      { day: '2026-11-08', closedReason: null, slots: [] },
      { day: '2026-11-09', closedReason: null, slots: [slot('b', false, 'This slot is full.'), slot('c', true)] },
    ]);
    expect(offer.days.map((d) => d.day)).toEqual(['2026-11-07', '2026-11-09']);
    expect(offer.earliest).toEqual({ day: '2026-11-09', slotId: 'c', words: 'Mon 9 Nov, Morning, 09:00 to 12:00' });
    expect(offer.days[0]?.slots[0]).toMatchObject({ available: false, note: 'This slot is full.' });
    expect(offer.days[1]?.slots[1]).toMatchObject({ available: true, note: null });
  });
  it('has no earliest time when nothing is free', () => {
    expect(shopOffer([{ day: '2026-11-07', closedReason: null, slots: [slot('b', false, 'Full')] }]).earliest).toBeNull();
    expect(shopOffer([]).earliest).toBeNull();
  });
});
