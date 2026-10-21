import { describe, expect, it } from 'vitest';
import {
  countedCents,
  countProblem,
  differenceWords,
  totalOfCount,
  totalTyped,
} from './cash-count';

const row = (value: string, count: string) => ({ value, count });

describe('counting cash', () => {
  it('adds notes and coins up in whole cents and ignores empty rows', () => {
    const out = totalOfCount([row('1000', '3'), row('50', '12'), row('0.50', '5'), row('', '')]);
    expect(out).toEqual({
      ok: true,
      value: {
        cents: 300_000 + 60_000 + 250,
        rows: [
          { value: '1000.00', count: 3 },
          { value: '50.00', count: 12 },
          { value: '0.50', count: 5 },
        ],
      },
    });
  });

  it('counts none of a denomination as zero', () => {
    expect(totalOfCount([row('100', '0')])).toEqual({
      ok: true,
      value: { cents: 0, rows: [{ value: '100.00', count: 0 }] },
    });
  });

  it('refuses a value that makes no sense, a repeated value, and a count that is not whole', () => {
    expect(totalOfCount([row('0', '1')])).toMatchObject({
      ok: false,
      error: expect.stringContaining('Row 1'),
    });
    expect(totalOfCount([row('abc', '1')])).toMatchObject({ ok: false });
    expect(totalOfCount([row('1.234', '1')])).toMatchObject({ ok: false });
    expect(totalOfCount([row('100', '1'), row('100.00', '2')])).toMatchObject({
      ok: false,
      error: expect.stringContaining('already counted'),
    });
    expect(totalOfCount([row('100', '1.5')])).toMatchObject({ ok: false });
    expect(totalOfCount([row('100', '-1')])).toMatchObject({ ok: false });
    expect(totalOfCount([row('100', '')])).toMatchObject({ ok: false });
    expect(totalOfCount([row('', '4')])).toMatchObject({ ok: false });
  });

  it('allows thousands separators and at most thirty kinds', () => {
    expect(totalOfCount([row('1,000', '1')])).toMatchObject({
      ok: true,
      value: { cents: 100_000 },
    });
    const many = Array.from({ length: 31 }, (_, i) => row(String(i + 1), '1'));
    expect(totalOfCount(many)).toMatchObject({
      ok: false,
      error: expect.stringContaining('at most 30'),
    });
  });

  it('says short, over or agreeing', () => {
    expect(differenceWords(0)).toBe('The cash agrees with the books.');
    expect(differenceWords(-12_550)).toBe('Short by 125.50.');
    expect(differenceWords(300)).toBe('Over by 3.00.');
  });

  it('wants an account and a reason only when the cash does not agree', () => {
    expect(countProblem(0, '', false)).toBeNull();
    expect(countProblem(-100, 'because', false)).toBe(
      'Choose the account the difference is written to.',
    );
    expect(countProblem(-100, 'oops', true)).toContain('at least 5 characters');
    expect(countProblem(-100, 'change given wrongly', true)).toBeNull();
  });

  it('reads a total typed in', () => {
    expect(totalTyped('12,500.50')).toEqual({ ok: true, value: 1_250_050 });
    expect(totalTyped('-5')).toMatchObject({ ok: false });
  });
});

describe('what was counted, however it was entered', () => {
  it('is the notes and coins added up, or the total typed', () => {
    expect(countedCents(true, [{ value: '100', count: '2' }], '999')).toEqual({
      ok: true,
      value: 20_000,
    });
    expect(countedCents(false, [{ value: '100', count: '2' }], '999.50')).toEqual({
      ok: true,
      value: 99_950,
    });
    expect(countedCents(true, [{ value: 'x', count: '2' }], '')).toMatchObject({ ok: false });
    expect(countedCents(false, [], 'abc')).toMatchObject({ ok: false });
  });
});
