import { describe, expect, it } from 'vitest';
import { formatCell, formatters } from './units';

describe('formatters', () => {
  it('writes money in full and short', () => {
    const f = formatters({ kind: 'money', currency: 'KES' });
    expect(f.value(1500)).toBe('KES 1,500');
    expect(f.value(12.5)).toBe('KES 12.50');
    expect(f.axis(0)).toBe('0');
    expect(f.axis(15_300)).toBe('15.3K');
    expect(f.axis(1_200_000)).toBe('1.2M');
  });

  it('writes counts and percentages', () => {
    const c = formatters({ kind: 'count' });
    expect(c.value(1234567)).toBe('1,234,567');
    expect(c.axis(1200)).toBe('1.2K');
    const p = formatters({ kind: 'percent' });
    expect(p.value(12.4)).toBe('12.4%');
    expect(p.axis(50)).toBe('50%');
  });
});

describe('formatCell', () => {
  it('writes each kind of cell', () => {
    expect(formatCell(1234.5, 'money')).toBe('1,234.50');
    expect(formatCell(-250, 'money')).toMatch(/^[-−]250\.00$/);
    expect(formatCell(1234567, 'count')).toBe('1,234,567');
    expect(formatCell(61.25, 'percent')).toBe('61.3%');
    expect(formatCell('Wanjiku', 'text')).toBe('Wanjiku');
    expect(formatCell('2026-03-10', 'date')).toBe('2026-03-10');
    expect(formatCell(null, 'money')).toBe('');
  });

  it('writes text as it is even in a number column', () => {
    expect(formatCell('Total', 'money')).toBe('Total');
  });
});
