import { describe, expect, it } from 'vitest';
import { durationWords, outcomeTone, reasonWords, stageTime, stageTimeShort } from './order-timeline-view';

describe('the time between two stages, in words', () => {
  it('reads seconds, minutes, hours and days', () => {
    expect(durationWords(400)).toBe('at once');
    expect(durationWords(45_000)).toBe('45 s');
    expect(durationWords(200_000)).toBe('3 min 20 s');
    expect(durationWords(180_000)).toBe('3 min');
    expect(durationWords(2 * 3600_000 + 5 * 60_000)).toBe('2 h 5 min');
    expect(durationWords(3 * 3600_000)).toBe('3 h');
    expect(durationWords(27 * 3600_000)).toBe('1 d 3 h');
  });
  it('says nothing for a missing or negative gap', () => {
    expect(durationWords(null)).toBe('');
    expect(durationWords(-5)).toBe('');
    expect(durationWords(Number.NaN)).toBe('');
  });
});

describe('stage times', () => {
  it('are shown in Nairobi time', () => {
    expect(stageTime('2026-01-01T09:00:05Z')).toMatch(/12:00:05/);
    expect(stageTimeShort('2026-01-01T09:00:05Z')).toMatch(/12:00/);
  });
});

describe('how an outcome and a reason read', () => {
  it('colours failures and cancellations as bad and successes as good', () => {
    expect([outcomeTone('failed'), outcomeTone('cancelled'), outcomeTone('succeeded'), outcomeTone('entered')]).toEqual(['bad', 'bad', 'good', 'neutral']);
  });
  it('turns reason codes into plain words, and shows an unknown one as written', () => {
    expect(reasonWords('quantity_limit')).toBe('Quantity outside the limits');
    expect(reasonWords('stock_short')).toBe('Not enough stock');
    expect(reasonWords('insufficient_funds')).toBe('insufficient funds');
    expect(reasonWords(null)).toBe('');
  });
});
