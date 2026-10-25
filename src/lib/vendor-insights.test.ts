import { describe, expect, it } from 'vitest';
import { WATCH_DEFAULTS, checkWatchSettings, daysBetween, isDay, percent, reportRange, showPercent } from './vendor-insights';

describe('vendor insight measures', () => {
  it('gives a share only when something was measured', () => {
    expect(percent(0, 0)).toBeNull();
    expect(percent(1, 3)).toBe(33.3);
    expect(percent(5, 4)).toBe(100);
    expect(showPercent(null)).toBe('Not measured');
    expect(showPercent(50)).toBe('50.0%');
  });
  it('accepts only real days and orders a range', () => {
    expect(isDay('2026-02-30')).toBe(false);
    expect(isDay('2026-10-25')).toBe(true);
    expect(reportRange(undefined, undefined, '2026-10-25')).toEqual({ from: '2025-10-25', to: '2026-10-25' });
    expect(reportRange('2026-05-01', '2026-01-01', '2026-10-25')).toEqual({ from: '2026-01-01', to: '2026-05-01' });
    expect(reportRange('nonsense', '2026-03-01', '2026-10-25').to).toBe('2026-03-01');
  });
  it('counts days and keeps watch settings sane', () => {
    expect(daysBetween('2026-10-01', '2026-10-25')).toBe(24);
    expect(checkWatchSettings({ duplicateWindowDays: -1, newVendorDays: 10.5 })).toEqual(WATCH_DEFAULTS);
    expect(checkWatchSettings({ duplicateWindowDays: 3 }).duplicateWindowDays).toBe(3);
  });
});
