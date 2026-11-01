import { describe, expect, it } from 'vitest';
import { hourOf, speedBuckets, summariseUsage } from './geo-metrics';

describe('summariseUsage', () => {
  it('turns sums into the shares and times a person weighs a provider by', () => {
    const [m] = summariseUsage([{ provider: 'osm', calls: 200, failures: 6, fallbacks: 5, totalMs: 120_000, maxMs: 9_000, under500: 100, under1000: 150, under2500: 190 }]);
    expect(m).toEqual({ provider: 'osm', calls: 200, successPercent: 97, fallbackPercent: 2.5, averageMs: 600, maxMs: 9000, within500Percent: 50, within1000Percent: 75, within2500Percent: 95 });
  });
  it('leaves out providers never called and lists the busiest first', () => {
    const out = summariseUsage([
      { provider: 'builtin', calls: 0, failures: 0, fallbacks: 0, totalMs: 0, maxMs: 0, under500: 0, under1000: 0, under2500: 0 },
      { provider: 'b', calls: 5, failures: 0, fallbacks: 0, totalMs: 50, maxMs: 20, under500: 5, under1000: 5, under2500: 5 },
      { provider: 'a', calls: 9, failures: 9, fallbacks: 9, totalMs: 90, maxMs: 20, under500: 9, under1000: 9, under2500: 9 },
    ]);
    expect(out.map((m) => m.provider)).toEqual(['a', 'b']);
    expect(out[0]).toMatchObject({ successPercent: 0, fallbackPercent: 100 });
  });
});

describe('speedBuckets and hourOf', () => {
  it('counts a quick call in every slower bucket too', () => {
    expect(speedBuckets(120)).toEqual({ under500: 1, under1000: 1, under2500: 1 });
    expect(speedBuckets(500)).toEqual({ under500: 0, under1000: 1, under2500: 1 });
    expect(speedBuckets(2500)).toEqual({ under500: 0, under1000: 0, under2500: 0 });
  });
  it('rounds down to the hour', () => {
    expect(hourOf(new Date('2026-11-01T10:59:59.999Z')).toISOString()).toBe('2026-11-01T10:00:00.000Z');
  });
});
