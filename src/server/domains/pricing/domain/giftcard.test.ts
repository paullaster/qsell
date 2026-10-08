import { describe, expect, it } from 'vitest';
import {
  checkGiftCardIssue,
  generateGiftCardCode,
  giftCardApplies,
  normaliseGiftCardCode,
} from './giftcard';
import { randomInt } from 'node:crypto';

describe('gift card codes', () => {
  it('are 16 characters in four groups, without look-alike characters', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateGiftCardCode((n) => randomInt(n));
      expect(code).toMatch(/^[A-HJKMNP-Z2-9]{4}(-[A-HJKMNP-Z2-9]{4}){3}$/);
    }
  });
  it('are different each time', () => {
    const set = new Set(
      Array.from({ length: 500 }, () => generateGiftCardCode((n) => randomInt(n))),
    );
    expect(set.size).toBe(500);
  });
  it('are typed forgivingly', () => {
    expect(normaliseGiftCardCode(' abcd efgh-jklm npqr ')).toBe('ABCD-EFGH-JKLM-NPQR');
    expect(normaliseGiftCardCode('ABCDEFGHJKMNPQRS')).toBe('ABCD-EFGH-JKMN-PQRS');
  });
});

describe('issuing', () => {
  const now = new Date('2026-10-08');
  it('accepts a normal card and refuses bad values, expiry and counts', () => {
    expect(checkGiftCardIssue({ value: 1000, expiresAt: null }, now)).toEqual([]);
    expect(checkGiftCardIssue({ value: 0, expiresAt: null }, now).length).toBe(1);
    expect(checkGiftCardIssue({ value: 10.005, expiresAt: null }, now).length).toBe(1);
    expect(checkGiftCardIssue({ value: 10_000_000, expiresAt: null }, now).length).toBe(1);
    expect(checkGiftCardIssue({ value: 10, expiresAt: new Date('2026-01-01') }, now).length).toBe(
      1,
    );
    expect(checkGiftCardIssue({ value: 10, expiresAt: null, count: 0 }, now).length).toBe(1);
    expect(checkGiftCardIssue({ value: 10, expiresAt: null, count: 501 }, now).length).toBe(1);
  });
  it('applies what is left against what is due', () => {
    expect(giftCardApplies(500, 300)).toBe(300);
    expect(giftCardApplies(100, 300)).toBe(100);
    expect(giftCardApplies(100, 0)).toBe(0);
  });
});
