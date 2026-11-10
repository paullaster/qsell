import { describe, expect, it } from 'vitest';
import { LOCK_AFTER, generatePin, lockWords, lockedUntil, normalizePhone, phoneWords, pinProblem, triesLeft } from './rider-pin';

describe('a Kenyan phone number as one string', () => {
  it('gives the same answer however it is written', () => {
    for (const written of ['0712 345 678', '+254712345678', '254712345678', '712345678', '0712-345-678', ' (0712) 345678 ']) expect(normalizePhone(written)).toBe('254712345678');
    expect(normalizePhone('0112345678')).toBe('254112345678');
  });

  it('refuses what is not a Kenyan mobile number', () => {
    for (const bad of ['', '0212345678', '+256712345678', '07123456', '071234567890', '0612345678', 'abc', null, 712345678, undefined]) expect(normalizePhone(bad)).toBeNull();
  });

  it('writes a number the way a person reads it', () => {
    expect(phoneWords('254712345678')).toBe('0712 345 678');
  });
});

describe('what a PIN may be', () => {
  it('takes six digits that are not obvious', () => {
    for (const ok of ['482915', '907351', '135790']) expect(pinProblem(ok)).toBeNull();
  });

  it('refuses the wrong length, letters, a repeat, a run, a favourite and the end of the rider\'s own number', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 456', 123456, null]) expect(pinProblem(bad)).toMatch(/6 digits/);
    expect(pinProblem('777777')).toMatch(/repeated/);
    expect(pinProblem('234567')).toMatch(/in a row/);
    expect(pinProblem('987654')).toMatch(/in a row/);
    expect(pinProblem('121212')).toMatch(/too easy/);
    expect(pinProblem('350792', '254712350792')).toMatch(/phone number/);
    expect(pinProblem('350792', '254799999999')).toBeNull();
  });

  it('hands out a PIN that passes its own rules, whatever the dice give', () => {
    let n = 0;
    expect(pinProblem(generatePin(() => (n += 1) % 10))).toBeNull();
    expect(pinProblem(generatePin(() => 7))).toBeNull();
    expect(pinProblem(generatePin(() => 0))).toBeNull();
    const rolls = [4, 8, 2, 9, 1, 5];
    let i = 0;
    expect(generatePin(() => rolls[i++ % rolls.length] ?? 0)).toBe('482915');
  });
});

describe('shutting a rider out after wrong tries', () => {
  const now = new Date('2026-11-10T08:00:00Z');
  it('lets them try until the fifth wrong one, then waits 15 minutes, doubling up to four hours', () => {
    for (let n = 0; n < LOCK_AFTER; n += 1) expect(lockedUntil(n, now)).toBeNull();
    const minutes = (n: number) => ((lockedUntil(n, now)?.getTime() ?? 0) - now.getTime()) / 60_000;
    expect(minutes(5)).toBe(15);
    expect(minutes(6)).toBe(30);
    expect(minutes(7)).toBe(60);
    expect(minutes(9)).toBe(240);
    expect(minutes(40)).toBe(240);
  });

  it('counts the tries left and writes the wait in words', () => {
    expect(triesLeft(0)).toBe(5);
    expect(triesLeft(4)).toBe(1);
    expect(triesLeft(9)).toBe(0);
    expect(lockWords(new Date(now.getTime() + 60_000), now)).toBe('1 minute');
    expect(lockWords(new Date(now.getTime() + 15 * 60_000), now)).toBe('15 minutes');
    expect(lockWords(new Date(now.getTime() + 125 * 60_000), now)).toBe('2 hours 5 min');
    expect(lockWords(new Date(now.getTime() + 60 * 60_000), now)).toBe('1 hour');
  });
});
