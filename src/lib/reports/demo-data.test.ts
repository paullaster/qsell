import { describe, expect, it } from 'vitest';
import { DEMO_BRANCHES, demoBranchMonths, demoDays } from './demo-data';

describe('demo data', () => {
  it('is the same every time', () => {
    expect(demoDays('2026-03-01', 30)).toEqual(demoDays('2026-03-01', 30));
    expect(demoBranchMonths()).toEqual(demoBranchMonths());
  });

  it('writes consecutive real days', () => {
    const days = demoDays('2026-02-26', 5);
    expect(days.map((d) => d.date)).toEqual([
      '2026-02-26',
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
      '2026-03-02',
    ]);
    for (const d of days) {
      expect(d.orders).toBeGreaterThan(0);
      expect(d.sales).toBeGreaterThan(0);
    }
  });

  it('is busier at the weekend and in December than on a quiet weekday in January', () => {
    const week = demoDays('2026-01-05', 7);
    const monday = week[0];
    const saturday = week[5];
    expect(saturday && monday ? saturday.orders > monday.orders : false).toBe(true);
    const dec = demoDays('2026-12-01', 31).reduce((a, d) => a + d.sales, 0) / 31;
    const jan = demoDays('2026-01-01', 31).reduce((a, d) => a + d.sales, 0) / 31;
    expect(dec).toBeGreaterThan(jan * 1.5);
  });

  it('gives each branch twelve months, with the capital ahead of the slow branch', () => {
    const { months, byBranch } = demoBranchMonths();
    expect(months).toHaveLength(12);
    expect(byBranch.map((b) => b.label)).toEqual([...DEMO_BRANCHES]);
    for (const b of byBranch) expect(b.values).toHaveLength(12);
    const total = (label: string) =>
      byBranch.find((b) => b.label === label)?.values.reduce((a, v) => a + v, 0) ?? 0;
    expect(total('Nairobi CBD')).toBeGreaterThan(total('Kisumu') * 2);
  });
});
