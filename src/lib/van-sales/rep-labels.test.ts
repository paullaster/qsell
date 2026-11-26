import { describe, expect, it } from 'vitest';
import { dayLabel, progressPercent, progressWords } from './rep-labels';

describe('which day', () => {
  it('says today, tomorrow and yesterday, and otherwise the weekday and date', () => {
    expect(dayLabel('2026-11-26', '2026-11-26')).toBe('Today');
    expect(dayLabel('2026-11-27', '2026-11-26')).toBe('Tomorrow');
    expect(dayLabel('2026-11-25', '2026-11-26')).toBe('Yesterday');
    expect(dayLabel('2026-11-30', '2026-11-26')).toBe('Mon 30 Nov');
    expect(dayLabel('2027-01-02', '2026-12-30')).toBe('Sat 2 Jan');
  });
  it('counts across month ends', () => {
    expect(dayLabel('2026-12-01', '2026-11-30')).toBe('Tomorrow');
    expect(dayLabel('2026-02-28', '2026-03-01')).toBe('Yesterday');
  });
});

describe('how far along', () => {
  it('says the visits done of the total, and when there are none or all are done', () => {
    expect(progressWords(3, 7)).toBe('3 of 7 visits');
    expect(progressWords(0, 1)).toBe('0 of 1 visit');
    expect(progressWords(7, 7)).toBe('All 7 visits done');
    expect(progressWords(1, 1)).toBe('All 1 visit done');
    expect(progressWords(0, 0)).toBe('No visits');
  });
  it('gives the share for a bar, never beyond a whole', () => {
    expect(progressPercent(3, 6)).toBe(50);
    expect(progressPercent(0, 0)).toBe(0);
    expect(progressPercent(9, 6)).toBe(100);
    expect(progressPercent(1, 3)).toBe(33);
  });
});
