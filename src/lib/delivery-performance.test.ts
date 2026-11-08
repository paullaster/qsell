import { describe, expect, it } from 'vitest';
import { averageMinutes, durationWords, fillPercent, rateTone, rateWords, ratePercent } from './delivery-performance';

describe('delivery performance rules', () => {
  it('takes a share with one decimal, and nothing from nothing', () => {
    expect(ratePercent(14, 15)).toBe(93.3);
    expect(ratePercent(3, 3)).toBe(100);
    expect(ratePercent(0, 4)).toBe(0);
    expect(ratePercent(1, 0)).toBeNull();
    expect(ratePercent(Number.NaN, 4)).toBeNull();
    // A part cannot be more than the whole or less than nothing.
    expect(ratePercent(9, 4)).toBe(100);
    expect(ratePercent(-2, 4)).toBe(0);
  });

  it('averages minutes, whole, and nothing without a count', () => {
    expect(averageMinutes(100, 3)).toBe(33);
    expect(averageMinutes(0, 2)).toBe(0);
    expect(averageMinutes(50, 0)).toBeNull();
  });

  it('writes lengths of time and rates for the screen', () => {
    expect(durationWords(null)).toBe('-');
    expect(durationWords(45)).toBe('45 min');
    expect(durationWords(60)).toBe('1 h');
    expect(durationWords(200)).toBe('3 h 20 min');
    expect(durationWords(1440)).toBe('1 day');
    expect(durationWords(1440 * 2 + 240)).toBe('2 days 4 h');
    expect(rateWords(null)).toBe('None promised');
    expect(rateWords(93.3)).toBe('93.3%');
  });

  it('judges a rate', () => {
    expect(rateTone(null)).toBe('none');
    expect(rateTone(100)).toBe('good');
    expect(rateTone(95)).toBe('good');
    expect(rateTone(94.9)).toBe('watch');
    expect(rateTone(80)).toBe('watch');
    expect(rateTone(79.9)).toBe('poor');
  });

  it('measures how full a slot ran', () => {
    expect(fillPercent(15, 30)).toBe(50);
    expect(fillPercent(0, 0)).toBeNull();
  });
});
