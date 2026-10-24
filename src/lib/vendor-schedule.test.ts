import { describe, expect, it } from 'vitest';
import { addBusinessDays, daysUntil, reminderDue } from './vendor-schedule';

describe('addBusinessDays', () => {
  it('skips the weekend', () => {
    // Thursday 2026-10-22 + 3 working days = Tuesday 2026-10-27
    expect(addBusinessDays(new Date('2026-10-22T09:00:00Z'), 3).toISOString()).toBe('2026-10-27T09:00:00.000Z');
  });
  it('moves a Friday request to the following Wednesday for three days', () => {
    expect(addBusinessDays(new Date('2026-10-23T09:00:00Z'), 3).toISOString()).toBe('2026-10-28T09:00:00.000Z');
  });
  it('zero days is the same moment', () => {
    expect(addBusinessDays(new Date('2026-10-24T09:00:00Z'), 0).toISOString()).toBe('2026-10-24T09:00:00.000Z');
  });
});

describe('daysUntil', () => {
  it('counts whole days, negative when past', () => {
    expect(daysUntil('2026-10-24', '2026-11-23')).toBe(30);
    expect(daysUntil('2026-10-24', '2026-10-24')).toBe(0);
    expect(daysUntil('2026-10-24', '2026-10-20')).toBe(-4);
  });
});

describe('reminderDue', () => {
  const t = [30, 7, 0];
  it('is silent while far from expiry', () => expect(reminderDue(45, t, null)).toBeNull());
  it('sends the 30-day reminder first', () => expect(reminderDue(29, t, null)).toBe(30));
  it('does not repeat a threshold', () => expect(reminderDue(20, t, 30)).toBeNull());
  it('moves to the next threshold', () => expect(reminderDue(6, t, 30)).toBe(7));
  it('skips to the nearest one when days were missed', () => expect(reminderDue(0, t, 30)).toBe(0));
  it('stops once expired', () => expect(reminderDue(-1, t, 7)).toBeNull());
});
