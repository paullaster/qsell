import { describe, expect, it } from 'vitest';
import {
  checkRebateProgram,
  effectivePercent,
  periodEnded,
  periodKey,
  periodLabel,
  periodRange,
  rebateFor,
  summariseRebate,
  toNextTier,
  type RebateProgramInput,
} from './rebate';

const tiers = [
  { from: 1_000_000, percent: 1 },
  { from: 5_000_000, percent: 2 },
];

describe('rebate periods', () => {
  it('names the period by the Nairobi calendar, not the server clock', () => {
    // 23:30 UTC on 31 Dec is already 1 Jan in Nairobi.
    const at = new Date('2026-12-31T23:30:00Z');
    expect(periodKey(at, 'year')).toBe('2027');
    expect(periodKey(at, 'month')).toBe('2027-01');
    expect(periodKey(at, 'quarter')).toBe('2027-Q1');
    expect(periodKey(new Date('2026-10-08T10:00:00Z'), 'quarter')).toBe('2026-Q4');
  });
  it('gives the first and last day, leap years included', () => {
    expect(periodRange('2026-Q4')).toEqual({ start: '2026-10-01', end: '2026-12-31' });
    expect(periodRange('2028-02')).toEqual({ start: '2028-02-01', end: '2028-02-29' });
    expect(periodRange('2026')).toEqual({ start: '2026-01-01', end: '2026-12-31' });
    expect(() => periodRange('nonsense')).toThrow();
  });
  it('knows when a period has ended', () => {
    expect(periodEnded('2026-09', new Date('2026-10-08T10:00:00Z'))).toBe(true);
    expect(periodEnded('2026-10', new Date('2026-10-08T10:00:00Z'))).toBe(false);
    expect(periodEnded('2026-10', new Date('2026-10-31T22:00:00Z'))).toBe(true); // already 1 Nov in Nairobi
  });
  it('labels', () => {
    expect(periodLabel('2026-Q4')).toBe('Quarter 4 2026');
    expect(periodLabel('2026-10')).toBe('October 2026');
  });
});

describe('what a period earns back', () => {
  it('all_sales: the step reached applies to everything', () => {
    expect(rebateFor(900_000, tiers, 'all_sales')).toBe(0);
    expect(rebateFor(1_000_000, tiers, 'all_sales')).toBe(10_000);
    expect(rebateFor(5_000_000, tiers, 'all_sales')).toBe(100_000);
    expect(rebateFor(6_000_000, tiers, 'all_sales')).toBe(120_000);
  });
  it('incremental: each step applies only above its threshold', () => {
    expect(rebateFor(900_000, tiers, 'incremental')).toBe(0);
    expect(rebateFor(2_000_000, tiers, 'incremental')).toBe(10_000);
    // 4M at 1% above the first step, then 1M at 2%.
    expect(rebateFor(6_000_000, tiers, 'incremental')).toBe(40_000 + 20_000);
  });
  it('is zero for nothing, for negative totals and with no steps', () => {
    expect(rebateFor(0, tiers, 'all_sales')).toBe(0);
    expect(rebateFor(-500, tiers, 'all_sales')).toBe(0);
    expect(rebateFor(100, [], 'all_sales')).toBe(0);
  });
  it('rounds to the cent', () => {
    expect(rebateFor(1_000_000.55, tiers, 'all_sales')).toBe(10_000.01);
  });
  it('never gives back more than the top rate, and never goes down as sales grow (all_sales above the first step)', () => {
    let prev = 0;
    for (let b = 1_000_000; b <= 9_000_000; b += 250_000) {
      const r = rebateFor(b, tiers, 'incremental');
      expect(r).toBeGreaterThanOrEqual(prev);
      expect(r).toBeLessThanOrEqual(b * 0.02);
      prev = r;
    }
  });
  it('says how far the next step is', () => {
    expect(toNextTier(4_000_000, tiers)).toEqual({ needed: 1_000_000, percent: 2 });
    expect(toNextTier(6_000_000, tiers)).toBeNull();
    expect(effectivePercent(6_000_000, tiers, 'incremental')).toBe(1);
  });
});

const program = (over: Partial<RebateProgramInput> = {}): RebateProgramInput => ({
  code: 'DIST-Q',
  name: 'Distributor quarterly',
  period: 'quarter',
  tierMode: 'all_sales',
  tiers,
  scopes: {},
  target: { all: true },
  validFrom: new Date('2026-01-01'),
  validTo: null,
  ...over,
});

describe('checking a programme', () => {
  it('accepts a sensible one', () => {
    expect(checkRebateProgram(program()).errors).toEqual([]);
  });
  it('refuses no steps, repeated steps, silly rates, and an end before the start', () => {
    expect(checkRebateProgram(program({ tiers: [] })).errors.map((e) => e.path)).toContain('tiers');
    expect(
      checkRebateProgram(
        program({
          tiers: [
            { from: 1, percent: 1 },
            { from: 1, percent: 2 },
          ],
        }),
      ).errors.length,
    ).toBeGreaterThan(0);
    expect(checkRebateProgram(program({ tiers: [{ from: 0, percent: 80 }] })).errors.length).toBe(
      1,
    );
    expect(checkRebateProgram(program({ tiers: [{ from: 0, percent: 0 }] })).errors.length).toBe(1);
    expect(
      checkRebateProgram(program({ validTo: new Date('2025-01-01') })).errors.map((e) => e.path),
    ).toContain('validTo');
  });
  it('warns when a higher step gives a lower rate', () => {
    const r = checkRebateProgram(
      program({
        tiers: [
          { from: 1, percent: 3 },
          { from: 100, percent: 1 },
        ],
      }),
    );
    expect(r.errors).toEqual([]);
    expect(r.warnings.length).toBe(1);
  });
  it('describes itself', () => {
    const s = summariseRebate(program());
    expect(s).toContain('1% from 1,000,000');
    expect(s).toContain('2% from 5,000,000');
    expect(s).toContain('all purchases');
    expect(s).toContain('a quarter');
  });
});
