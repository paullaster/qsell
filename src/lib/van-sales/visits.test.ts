import { describe, expect, it } from 'vitest';
import { dayNumber, dueStops, isDue, isOverdue, maskOf, visitPlanProblem, weekdayIndex, weekdaysOf, weekdayWords, type Stop } from './visits';

const MON = 0;
const WED = 2;
const stop = (over: Partial<Stop> = {}): Stop => ({ customerId: 'c1', sequence: 1, visitDays: maskOf([MON]), every: 1, anchor: '2026-11-02', active: true, ...over });

describe('weekdays', () => {
  it('knows the day of the week of a business date', () => {
    expect(weekdayIndex(dayNumber('2026-11-23') ?? 0)).toBe(0); // Monday
    expect(weekdayIndex(dayNumber('2026-11-29') ?? 0)).toBe(6); // Sunday
    expect(weekdayIndex(dayNumber('1970-01-01') ?? 0)).toBe(3); // Thursday
    expect(weekdayIndex(dayNumber('1969-12-31') ?? 0)).toBe(2); // before the epoch
  });
  it('refuses a date that does not exist', () => {
    expect(dayNumber('2026-02-30')).toBeNull();
    expect(dayNumber('2026-13-01')).toBeNull();
    expect(dayNumber('23/11/2026')).toBeNull();
    expect(dayNumber('2028-02-29')).not.toBeNull();
  });
  it('turns days into a mask and back, and says them in words', () => {
    expect(maskOf([MON, WED])).toBe(0b101);
    expect(weekdaysOf(0b101)).toEqual([0, 2]);
    expect(weekdayWords(0b101)).toBe('Mon, Wed');
    expect(weekdayWords(0)).toBe('No day');
    expect(weekdayWords(0b1111111)).toBe('Every day');
    expect(maskOf([9, -1, 1.5])).toBe(0);
  });
});

describe('visit plan', () => {
  it('needs a day, a frequency and a start date', () => {
    expect(visitPlanProblem(0b1, 1, '2026-11-02')).toBeNull();
    expect(visitPlanProblem(0, 1, '2026-11-02')).toContain('at least one day');
    expect(visitPlanProblem(0b1, 3, '2026-11-02')).toContain('how often');
    expect(visitPlanProblem(0b1, 1, 'soon')).toContain('date the visits start');
    expect(visitPlanProblem(1 << 7, 1, '2026-11-02')).toContain('at least one day');
  });
});

describe('who is due on a day', () => {
  it('visits every week on the chosen days', () => {
    const s = stop({ visitDays: maskOf([MON, WED]) });
    expect(isDue(s, '2026-11-02')).toBe(true); // Mon
    expect(isDue(s, '2026-11-04')).toBe(true); // Wed
    expect(isDue(s, '2026-11-03')).toBe(false); // Tue
    expect(isDue(s, '2026-11-09')).toBe(true);
  });
  it('visits every second and fourth week from the week it started', () => {
    const fortnight = stop({ every: 2 });
    expect(['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23'].map((d) => isDue(fortnight, d))).toEqual([true, false, true, false]);
    const month = stop({ every: 4 });
    expect(['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30'].map((d) => isDue(month, d))).toEqual([true, false, false, false, true]);
  });
  it('counts weeks from the week of the start date, whichever weekday it fell on', () => {
    const s = stop({ every: 2, anchor: '2026-11-05', visitDays: maskOf([MON]) }); // started on a Thursday of the week of 2 Nov
    expect(isDue(s, '2026-11-02')).toBe(false); // before it started
    expect(isDue(s, '2026-11-09')).toBe(false); // next week
    expect(isDue(s, '2026-11-16')).toBe(true); // two weeks on
  });
  it('is never due before it starts, when stopped, or on a bad date', () => {
    expect(isDue(stop({ anchor: '2026-12-07' }), '2026-11-30')).toBe(false);
    expect(isDue(stop({ active: false }), '2026-11-02')).toBe(false);
    expect(isDue(stop(), 'nonsense')).toBe(false);
  });
  it('lists the due stops in route order', () => {
    const stops = [stop({ customerId: 'b', sequence: 3 }), stop({ customerId: 'a', sequence: 1 }), stop({ customerId: 'x', sequence: 2, visitDays: maskOf([WED]) }), stop({ customerId: 'c', sequence: 2 })];
    expect(dueStops(stops, '2026-11-02').map((s) => s.customerId)).toEqual(['a', 'c', 'b']);
  });
});

describe('who is overdue', () => {
  it('is overdue when more than one cycle has passed since the last visit and not due today', () => {
    const s = stop({ every: 1 });
    expect(isOverdue(s, '2026-11-12', '2026-11-02')).toBe(true); // 10 days, a Thursday: not due
    expect(isOverdue(s, '2026-11-08', '2026-11-02')).toBe(false); // 6 days
    expect(isOverdue(s, '2026-11-09', '2026-11-02')).toBe(false); // due today, so not overdue
    expect(isOverdue(stop({ every: 2 }), '2026-11-20', '2026-11-02')).toBe(true);
    expect(isOverdue(stop({ every: 2 }), '2026-11-12', '2026-11-02')).toBe(false);
  });
  it('counts from the start of the stop when it was never visited', () => {
    expect(isOverdue(stop(), '2026-11-12', null)).toBe(true);
    expect(isOverdue(stop({ anchor: '2026-11-11' }), '2026-11-12', null)).toBe(false);
    expect(isOverdue(stop({ anchor: '2026-12-01' }), '2026-11-12', null)).toBe(false);
  });
});
