import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  deltaOf,
  formatCompact,
  formatCount,
  formatDateRange,
  formatInstant,
  formatLocalDate,
  formatMoney,
  formatMoneyShort,
  formatPercent,
  signOf,
} from '@/lib/reports/format';

describe('money', () => {
  it('shows whole amounts without cents and small fractions with two places', () => {
    expect(formatMoney(1500, 'KES')).toBe('KES 1,500');
    expect(formatMoney(12, 'KES')).toBe('KES 12');
    expect(formatMoney(12.5, 'KES')).toBe('KES 12.50');
    expect(formatMoney(1234567.89, 'KES')).toBe('KES 1,234,568');
    expect(formatMoney(0, 'KES')).toBe('KES 0');
  });

  it('writes a negative amount with its sign', () => {
    expect(formatMoney(-2500, 'KES')).toMatch(/^KES [-−]2,500$/);
  });

  it('shortens large amounts for tiles and axes', () => {
    expect(formatMoneyShort(999, 'KES')).toBe('KES 999');
    expect(formatMoneyShort(15_300, 'KES')).toBe('KES 15.3K');
    expect(formatMoneyShort(150_000, 'KES')).toBe('KES 150K');
    expect(formatMoneyShort(1_200_000, 'KES')).toBe('KES 1.2M');
    expect(formatMoneyShort(10_000_000, 'KES')).toBe('KES 10M');
    expect(formatMoneyShort(-1_200_000, 'KES')).toBe('KES -1.2M');
  });

  it('keeps the currency code the caller gives', () => {
    expect(formatMoney(40, 'USD')).toBe('USD 40');
  });
});

describe('counts and percentages', () => {
  it('groups thousands', () => {
    expect(formatCount(1234567)).toBe('1,234,567');
    expect(formatCount(0)).toBe('0');
  });

  it('writes compact counts', () => {
    expect(formatCompact(1200)).toBe('1.2K');
    expect(formatCompact(999)).toBe('999');
  });

  it('keeps the trailing zero of a percentage so a column lines up', () => {
    expect(formatPercent(12.4)).toBe('12.4%');
    expect(formatPercent(12)).toBe('12.0%');
    expect(formatPercent(12.345, 2)).toBe('12.35%');
    expect(formatPercent(0, 0)).toBe('0%');
  });

  it('formats with the locale given, not the browser', () => {
    expect(DEFAULT_LOCALE).toBe('en-KE');
    expect(formatCount(1234567, 'de-DE')).toBe('1.234.567');
  });
});

describe('change between two figures', () => {
  it('reports direction and a rounded percentage', () => {
    expect(deltaOf(112.4, 100)).toEqual({ direction: 'up', percent: 12.4 });
    expect(deltaOf(80, 100)).toEqual({ direction: 'down', percent: 20 });
    expect(deltaOf(100, 100)).toEqual({ direction: 'flat', percent: 0 });
  });

  it('does not invent a percentage when there is nothing to compare with', () => {
    expect(deltaOf(50, 0)).toEqual({ direction: 'up', percent: null });
    expect(deltaOf(0, 0)).toEqual({ direction: 'flat', percent: null });
    expect(deltaOf(10, Number.NaN)).toEqual({ direction: 'down', percent: null });
  });

  it('treats a change that rounds to nothing as flat', () => {
    expect(deltaOf(100.01, 100)).toEqual({ direction: 'flat', percent: 0 });
  });

  it('writes a sign with the real minus', () => {
    expect(signOf(5)).toBe('+');
    expect(signOf(-5)).toBe('−');
    expect(signOf(0)).toBe('');
  });
});

describe('dates', () => {
  it('writes a local date without shifting the day', () => {
    expect(formatLocalDate('2026-10-15')).toMatch(/^15 Oct 2026$/);
    expect(formatLocalDate('2026-01-01')).toMatch(/^1 Jan 2026$/);
    expect(formatLocalDate('2028-02-29')).toMatch(/^29 Feb 2028$/);
  });

  it('writes a range, and one day when both ends are the same', () => {
    expect(formatDateRange('2026-10-15', '2026-10-15')).toBe(formatLocalDate('2026-10-15'));
    expect(formatDateRange('2026-10-01', '2026-10-15')).toBe('1 Oct 2026 – 15 Oct 2026');
  });

  it('writes an instant in the time zone given, whatever the machine uses', () => {
    // 21:05 UTC on 15 Oct is 00:05 on 16 Oct in Nairobi (UTC+3) and 06:05 on 16 Oct in Tokyo (UTC+9).
    const iso = '2026-10-15T21:05:00.000Z';
    expect(formatInstant(iso, 'Africa/Nairobi')).toMatch(/16 Oct.*00:05/);
    expect(formatInstant(iso, 'Asia/Tokyo')).toMatch(/16 Oct.*06:05/);
    expect(formatInstant(iso, 'UTC')).toMatch(/15 Oct.*21:05/);
  });
});
