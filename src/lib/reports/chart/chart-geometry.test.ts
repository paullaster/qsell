import { describe, expect, it } from 'vitest';
import { arcPath, areaPath, barPath, linePath, sliceAngles } from './paths';
import { bandIndexAt, bandScale, linearScale, niceAxis, niceNumber } from './scale';

describe('nice numbers and axes', () => {
  it('rounds a range to 1, 2, 5 or 10 times a power of ten', () => {
    expect(niceNumber(0.8, true)).toBe(1);
    expect(niceNumber(23, true)).toBe(20);
    expect(niceNumber(47, true)).toBe(50);
    expect(niceNumber(950, true)).toBe(1000);
    expect(niceNumber(4730, false)).toBe(5000);
    expect(niceNumber(0, true)).toBe(1);
    expect(niceNumber(Number.NaN, true)).toBe(1);
  });

  it('gives round ticks that cover the data and start at zero', () => {
    const a = niceAxis(0, 4730);
    expect(a.min).toBe(0);
    expect(a.max).toBeGreaterThanOrEqual(4730);
    expect(a.ticks[0]).toBe(0);
    expect(a.ticks.at(-1)).toBe(a.max);
    for (const t of a.ticks) expect(t % a.step).toBeCloseTo(0, 6);
  });

  it('includes zero when every value is positive or every value is negative', () => {
    expect(niceAxis(120, 480).min).toBe(0);
    const neg = niceAxis(-480, -120);
    expect(neg.max).toBe(0);
    expect(neg.min).toBeLessThanOrEqual(-480);
  });

  it('spans both sides for data above and below zero', () => {
    const a = niceAxis(-300, 900);
    expect(a.min).toBeLessThanOrEqual(-300);
    expect(a.max).toBeGreaterThanOrEqual(900);
    expect(a.ticks).toContain(0);
  });

  it('copes with nothing, one value and noise', () => {
    expect(niceAxis(0, 0).max).toBeGreaterThan(0);
    expect(niceAxis(5, 5).ticks.length).toBeGreaterThan(1);
    expect(niceAxis(Number.NaN, Number.NaN).ticks.length).toBeGreaterThan(1);
    const small = niceAxis(0, 0.7);
    for (const t of small.ticks) expect(String(t).length).toBeLessThan(8);
  });

  it('never invents float noise in ticks', () => {
    for (const t of niceAxis(0, 0.9, 10).ticks) expect(Number(t.toFixed(10))).toBe(t);
  });
});

describe('scales', () => {
  it('maps a domain onto a range, including inverted ranges for a y axis', () => {
    const y = linearScale([0, 100], [200, 0]);
    expect(y(0)).toBe(200);
    expect(y(100)).toBe(0);
    expect(y(25)).toBe(150);
  });

  it('puts everything in the middle for a flat domain', () => {
    expect(linearScale([5, 5], [0, 100])(5)).toBe(50);
  });

  it('lays out bands with padding and finds the band under a pointer', () => {
    const b = bandScale(4, [0, 400], 0.5);
    expect(b.step).toBe(100);
    expect(b.width).toBe(50);
    expect(b.start(0)).toBe(25);
    expect(b.center(1)).toBe(150);
    expect(bandIndexAt(0, 4, [0, 400])).toBe(0);
    expect(bandIndexAt(399, 4, [0, 400])).toBe(3);
    expect(bandIndexAt(-50, 4, [0, 400])).toBe(0);
    expect(bandIndexAt(900, 4, [0, 400])).toBe(3);
    expect(bandIndexAt(10, 4, [0, 0])).toBe(0);
  });

  it('survives zero bands and silly padding', () => {
    expect(bandScale(0, [0, 100]).step).toBe(100);
    expect(bandScale(3, [0, 90], 5).width).toBeCloseTo(3, 6);
    expect(bandScale(3, [0, 90], -1).width).toBe(30);
  });
});

describe('paths', () => {
  const x = (i: number) => i * 10;
  const y = (v: number) => 100 - v;

  it('draws a line and breaks it at a missing value', () => {
    expect(linePath([10, 20, 30], x, y)).toBe('M0 90L10 80L20 70');
    expect(linePath([10, null, 30], x, y)).toBe('M0 90M20 70');
    expect(linePath([], x, y)).toBe('');
    expect(linePath([null, null], x, y)).toBe('');
  });

  it('keeps a lone point visible', () => {
    expect(linePath([null, 40, null], x, y)).toBe('M10 60h0.01');
  });

  it('fills an area down to the baseline, in pieces across gaps', () => {
    expect(areaPath([10, 20], x, y, 100)).toBe('M0 90L10 80L10 100L0 100Z');
    const two = areaPath([10, null, 30, 40], x, y, 100);
    expect(two.match(/Z/g)).toHaveLength(2);
    expect(areaPath([null], x, y, 100)).toBe('');
  });

  it('draws a bar with rounded top corners and nothing for an empty bar', () => {
    expect(barPath(0, 0, 20, 50)).toContain('Q');
    expect(barPath(0, 0, 20, 0)).toBe('');
    expect(barPath(0, 0, 0, 20)).toBe('');
    expect(barPath(0, 0, 20, 2, 10)).not.toContain('NaN');
  });

  it('draws a ring segment and never a degenerate or full-circle bug', () => {
    expect(arcPath(50, 50, 30, 45, 0, Math.PI / 2)).toMatch(/^M.*A.*L.*A.*Z$/);
    expect(arcPath(50, 50, 30, 45, 1, 1)).toBe('');
    expect(arcPath(50, 50, 30, 45, 0, Math.PI * 2)).not.toContain('NaN');
  });

  it('sizes slices by value and ignores zero, negative and bad values', () => {
    const s = sliceAngles([1, 1, 2]);
    expect(s.map((x) => x.share)).toEqual([0.25, 0.25, 0.5]);
    expect(s[2]?.to).toBeCloseTo(Math.PI * 2, 10);
    expect(sliceAngles([0, -5, Number.NaN])).toEqual([]);
    expect(sliceAngles([3, 0, 1]).map((x) => x.index)).toEqual([0, 2]);
  });
});
