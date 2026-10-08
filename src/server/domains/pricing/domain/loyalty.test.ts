import { describe, expect, it } from 'vitest';
import {
  checkLoyalty,
  pointsEarned,
  pointsValue,
  redemption,
  summariseLoyalty,
  tierFor,
  type LoyaltyConfig,
} from './loyalty';

const cfg = (over: Partial<LoyaltyConfig> = {}): LoyaltyConfig => ({
  pointsPer100: 1,
  pointValue: 1,
  minRedeemPoints: 50,
  maxRedeemPercent: 50,
  expiryMonths: 12,
  tiers: [
    { name: 'Silver', fromPoints: 1000, multiplier: 1.5 },
    { name: 'Gold', fromPoints: 5000, multiplier: 2 },
  ],
  ...over,
});

describe('earning points', () => {
  it('rounds down and uses the tier multiplier', () => {
    expect(pointsEarned(1999, cfg())).toBe(19);
    expect(pointsEarned(1000, cfg(), 1000)).toBe(15);
    expect(pointsEarned(1000, cfg(), 5000)).toBe(20);
  });
  it('earns nothing on nothing', () => {
    expect(pointsEarned(0, cfg())).toBe(0);
    expect(pointsEarned(-100, cfg())).toBe(0);
  });
  it('does not lose a point to float error', () => {
    expect(pointsEarned(29, cfg({ pointsPer100: 100 }))).toBe(29);
  });
  it('finds the tier', () => {
    expect(tierFor(10, cfg().tiers)).toBeNull();
    expect(tierFor(1000, cfg().tiers)?.name).toBe('Silver');
    expect(tierFor(99999, cfg().tiers)?.name).toBe('Gold');
  });
});

describe('spending points', () => {
  it('uses all it can: capped by balance and by the share of the order', () => {
    expect(redemption(1000, 10_000, cfg())).toMatchObject({
      points: 500,
      value: 500,
      problem: null,
    });
    expect(redemption(1000, 120, cfg())).toMatchObject({ points: 120, value: 120 });
  });
  it('honours a requested amount', () => {
    expect(redemption(1000, 800, cfg(), 200)).toMatchObject({ points: 200, value: 200 });
  });
  it('is capped even when more is asked for', () => {
    expect(redemption(1000, 800, cfg(), 700)).toMatchObject({ points: 500 });
  });
  it('says why not', () => {
    expect(redemption(1000, 100, cfg(), 200).problem).toContain('Only 100');
    expect(redemption(1000, 30, cfg()).problem).toContain('At least 50');
    expect(redemption(0, 100, cfg()).problem).toContain('Nothing is left');
    expect(redemption(1000, 100, cfg(), 1.5).problem).toContain('whole number');
  });
  it('values points by the point value', () => {
    expect(pointsValue(100, cfg({ pointValue: 0.25 }))).toBe(25);
  });
});

describe('checking the programme', () => {
  it('accepts a sensible one and refuses nonsense', () => {
    expect(checkLoyalty(cfg()).errors).toEqual([]);
    expect(checkLoyalty(cfg({ pointValue: 0 })).errors.length).toBe(1);
    expect(checkLoyalty(cfg({ maxRedeemPercent: 150 })).errors.length).toBe(1);
    expect(
      checkLoyalty(cfg({ tiers: [{ name: '', fromPoints: -1, multiplier: 0.5 }] })).errors.length,
    ).toBe(3);
  });
  it('warns when the giveaway is generous', () => {
    expect(checkLoyalty(cfg({ pointsPer100: 20 })).warnings.length).toBe(1);
  });
  it('describes itself', () => {
    expect(summariseLoyalty(cfg())).toContain('1 point(s) for every 100 spent');
  });
});
