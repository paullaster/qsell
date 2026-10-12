import { describe, expect, it } from 'vitest';
import { resolvePeriod } from './period';

const TZ = 'Africa/Nairobi'; // UTC+3, no DST
// 2026-10-15 14:00 Nairobi
const NOW = new Date('2026-10-15T11:00:00Z');

describe('resolvePeriod', () => {
  it('uses business-timezone day boundaries, not UTC', () => {
    const p = resolvePeriod({ preset: 'today' }, NOW, TZ);
    expect(p.from.toISOString()).toBe('2026-10-14T21:00:00.000Z');
    expect(p.to.toISOString()).toBe('2026-10-15T21:00:00.000Z');
    expect(p.fromDate).toBe('2026-10-15');
    expect(p.toDate).toBe('2026-10-15');
  });

  it('assigns a late-night UTC instant to the next local day', () => {
    const late = new Date('2026-10-15T22:30:00Z'); // 01:30 on the 16th in Nairobi
    expect(resolvePeriod({ preset: 'today' }, late, TZ).fromDate).toBe('2026-10-16');
  });

  it('compares a running day like-for-like with the same elapsed time yesterday', () => {
    const p = resolvePeriod({ preset: 'today' }, NOW, TZ);
    expect(p.previous.from.toISOString()).toBe('2026-10-13T21:00:00.000Z');
    expect(p.previous.to.toISOString()).toBe('2026-10-14T11:00:00.000Z');
  });

  it('compares a finished period with the whole previous one', () => {
    const p = resolvePeriod({ preset: 'last_month' }, NOW, TZ);
    expect(p.fromDate).toBe('2026-09-01');
    expect(p.toDate).toBe('2026-09-30');
    expect(p.days).toHaveLength(30);
    expect(p.previous.fromDate).toBe('2026-08-01');
    expect(p.previous.toDate).toBe('2026-08-31');
  });

  it('this month runs from the 1st and is compared with the previous month so far', () => {
    const p = resolvePeriod({ preset: 'this_month' }, NOW, TZ);
    expect(p.fromDate).toBe('2026-10-01');
    expect(p.previous.fromDate).toBe('2026-09-01');
    expect(p.previous.to.getTime() - p.previous.from.getTime()).toBe(
      NOW.getTime() - p.from.getTime(),
    );
  });

  it('last 7 days is exactly 7 local days ending today', () => {
    const p = resolvePeriod({ preset: 'last_7_days' }, NOW, TZ);
    expect(p.days).toHaveLength(7);
    expect(p.days[0]).toBe('2026-10-09');
    expect(p.days[6]).toBe('2026-10-15');
  });

  it('accepts a valid custom range and clamps the future', () => {
    const p = resolvePeriod({ preset: 'custom', from: '2026-10-01', to: '2026-12-31' }, NOW, TZ);
    expect(p.preset).toBe('custom');
    expect(p.toDate).toBe('2026-10-15');
    expect(p.notice).toBeNull();
  });

  it('falls back with a notice on an invalid custom range', () => {
    for (const bad of [
      { from: '2026-10-10', to: '2026-10-01' },
      { from: 'nope', to: '2026-10-01' },
      { from: '2024-01-01', to: '2026-10-01' },
      { from: '2026-02-30', to: '2026-03-01' },
    ]) {
      const p = resolvePeriod({ preset: 'custom', ...bad }, NOW, TZ);
      expect(p.preset).toBe('last_30_days');
      expect(p.notice).not.toBeNull();
    }
  });

  it('defaults unknown presets to the last 30 days', () => {
    expect(resolvePeriod({ preset: 'bogus' }, NOW, TZ).days).toHaveLength(30);
  });

  it('is deterministic for the same input and clock', () => {
    expect(resolvePeriod({ preset: 'this_month' }, NOW, TZ)).toEqual(
      resolvePeriod({ preset: 'this_month' }, NOW, TZ),
    );
  });

  it('this quarter starts on the first day of the quarter and compares with the previous quarter so far', () => {
    const p = resolvePeriod({ preset: 'this_quarter' }, NOW, TZ);
    expect(p.fromDate).toBe('2026-10-01');
    expect(p.previous.fromDate).toBe('2026-07-01');
    expect(p.previous.to.getTime() - p.previous.from.getTime()).toBe(
      NOW.getTime() - p.from.getTime(),
    );
  });

  it('this year runs from 1 January and compares with last year so far', () => {
    const p = resolvePeriod({ preset: 'this_year' }, NOW, TZ);
    expect(p.fromDate).toBe('2026-01-01');
    expect(p.days).toHaveLength(288);
    expect(p.previous.fromDate).toBe('2025-01-01');
    expect(p.previous.to.getTime() - p.previous.from.getTime()).toBe(
      NOW.getTime() - p.from.getTime(),
    );
  });

  it('can compare with the same dates last year', () => {
    const p = resolvePeriod({ preset: 'last_7_days', compare: 'previous_year' }, NOW, TZ);
    expect(p.compare).toBe('previous_year');
    expect(p.previous.fromDate).toBe('2025-10-09');
    expect(p.previous.toDate).toBe('2025-10-15');
  });

  it('copes with a leap day when comparing with last year', () => {
    const leapNow = new Date('2028-02-29T09:00:00Z');
    const p = resolvePeriod({ preset: 'today', compare: 'previous_year' }, leapNow, TZ);
    expect(p.previous.fromDate).toBe('2027-02-28');
  });

  it('ignores an unknown compare mode', () => {
    expect(resolvePeriod({ preset: 'today', compare: 'nope' }, NOW, TZ).compare).toBe(
      'previous_period',
    );
  });
});
