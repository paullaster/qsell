import { describe, expect, it } from 'vitest';
import { MAX_CODE_TRIES, codeFromBytes, codesMatch, isClientKey, isProofRule, normaliseCode, placeFrom, proofProblem, proofsKept, ruleFor, usableClientTime, usesCode } from './delivery-proof';

describe('delivery proof', () => {
  it('knows which rules give the customer a code', () => {
    expect(['none', 'code', 'photo', 'code_or_photo'].map((r) => isProofRule(r) && usesCode(r))).toEqual([false, true, false, true]);
    expect(isProofRule('signature')).toBe(false);
    expect(MAX_CODE_TRIES).toBe(5);
  });

  it('makes six digits and keeps leading zeros', () => {
    expect(codeFromBytes(new Uint8Array([0, 0, 0, 7]))).toBe('000007');
    expect(codeFromBytes(new Uint8Array([255, 255, 255, 255]))).toMatch(/^\d{6}$/);
    expect(codeFromBytes(new Uint8Array([]))).toBe('000000');
  });

  it('compares codes ignoring spaces and dashes, and never matches a missing or malformed code', () => {
    expect(codesMatch('123 456', '123456')).toBe(true);
    expect(codesMatch('123-456', '123456')).toBe(true);
    expect(codesMatch('123457', '123456')).toBe(false);
    expect(codesMatch('12345', '123456')).toBe(false);
    expect(codesMatch('123456', null)).toBe(false);
    expect(codesMatch(123456, '123456')).toBe(false);
    expect(codesMatch('', '')).toBe(false);
    expect(normaliseCode(' 1 2-3 ')).toBe('123');
  });

  it('says what is missing for each rule', () => {
    expect(proofProblem('none', { codeMatched: false, hasPhoto: false })).toBeNull();
    expect(proofProblem('code', { codeMatched: false, hasPhoto: true })).not.toBeNull();
    expect(proofProblem('code', { codeMatched: true, hasPhoto: false })).toBeNull();
    expect(proofProblem('photo', { codeMatched: true, hasPhoto: false })).not.toBeNull();
    expect(proofProblem('photo', { codeMatched: false, hasPhoto: true })).toBeNull();
    expect(proofProblem('code_or_photo', { codeMatched: false, hasPhoto: false })).not.toBeNull();
    expect(proofProblem('code_or_photo', { codeMatched: false, hasPhoto: true })).toBeNull();
    expect(proofProblem('code_or_photo', { codeMatched: true, hasPhoto: false })).toBeNull();
  });

  it('falls back to a photo for a delivery that has no code', () => {
    expect(['none', 'code', 'photo', 'code_or_photo'].map((r) => (isProofRule(r) ? ruleFor(r, false) : r))).toEqual(['none', 'photo', 'photo', 'photo']);
    expect(ruleFor('code', true)).toBe('code');
  });

  it('keeps the proofs that were given, a code only when the rule uses one', () => {
    expect(proofsKept('code_or_photo', { codeMatched: true, hasPhoto: true })).toEqual(['code', 'photo']);
    expect(proofsKept('photo', { codeMatched: true, hasPhoto: true })).toEqual(['photo']);
    expect(proofsKept('none', { codeMatched: false, hasPhoto: false })).toEqual([]);
  });

  it('keeps a phone time only when it is within a day of the server', () => {
    const now = new Date('2026-11-04T10:00:00Z');
    expect(usableClientTime('2026-11-04T09:00:00Z', now)?.toISOString()).toBe('2026-11-04T09:00:00.000Z');
    expect(usableClientTime('2026-11-01T09:00:00Z', now)).toBeNull();
    expect(usableClientTime('soon', now)).toBeNull();
    expect(usableClientTime(null, now)).toBeNull();
  });

  it('keeps a place only when both numbers are real coordinates', () => {
    expect(placeFrom(-1.2921, 36.8219)).toEqual({ lat: -1.2921, lng: 36.8219 });
    expect(placeFrom(91, 0)).toBeNull();
    expect(placeFrom(0, 181)).toBeNull();
    expect(placeFrom('1', 1)).toBeNull();
    expect(placeFrom(Number.NaN, 1)).toBeNull();
  });

  it('accepts a long enough key of plain characters', () => {
    expect(isClientKey('0123456789abcdef')).toBe(true);
    expect(isClientKey('short')).toBe(false);
    expect(isClientKey('has spaces in it, and more')).toBe(false);
    expect(isClientKey(undefined)).toBe(false);
  });
});
