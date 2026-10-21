import { describe, expect, it } from 'vitest';
import { checkChargeSplit, chargeLeftCents } from './charge-split';

const part = (glAccountId: string, amount: string, description?: string) => ({
  glAccountId,
  amount,
  description,
});

describe('splitting a bank charge', () => {
  it('accepts parts that add up exactly, in whole cents', () => {
    const out = checkChargeSplit(11_500, [part('fee', '100.00', ' Fee '), part('duty', '15')]);
    expect(out).toEqual({
      ok: true,
      value: [
        { glAccountId: 'fee', cents: 10_000, description: 'Fee' },
        { glAccountId: 'duty', cents: 1_500, description: '' },
      ],
    });
  });

  it('says how much is still to place, or how much too much was placed', () => {
    expect(checkChargeSplit(11_500, [part('fee', '100')])).toEqual({
      ok: false,
      error: 'The parts come to 100.00; 15.00 is still to place to make 115.00.',
    });
    expect(checkChargeSplit(11_500, [part('fee', '100'), part('duty', '20')])).toEqual({
      ok: false,
      error: 'The parts come to 120.00, which is 5.00 more than the 115.00 the bank took.',
    });
  });

  it('refuses a part without an account, with a bad amount, or a repeated account', () => {
    expect(checkChargeSplit(100, [part('', '1.00')])).toMatchObject({
      ok: false,
      error: 'Part 1: choose the account it belongs to.',
    });
    expect(checkChargeSplit(100, [part('a', '0')])).toMatchObject({
      ok: false,
      error: expect.stringContaining('Part 1: the amount'),
    });
    expect(checkChargeSplit(100, [part('a', '1.234')])).toMatchObject({ ok: false });
    expect(checkChargeSplit(100, [part('a', '-1')])).toMatchObject({ ok: false });
    expect(checkChargeSplit(200, [part('a', '1.00'), part('a', '1.00')])).toMatchObject({
      ok: false,
      error: expect.stringContaining('already used'),
    });
  });

  it('needs at least one part and not more than ten', () => {
    expect(checkChargeSplit(100, [])).toMatchObject({ ok: false });
    const eleven = Array.from({ length: 11 }, (_, i) => part(`a${String(i)}`, '1.00'));
    expect(checkChargeSplit(1100, eleven)).toMatchObject({
      ok: false,
      error: expect.stringContaining('at most 10'),
    });
  });

  it('adds thousands separators away and tracks what is left', () => {
    expect(checkChargeSplit(100_000, [part('a', '1,000.00')])).toMatchObject({ ok: true });
    expect(chargeLeftCents(11_500, ['100', 'x', ''])).toBe(1_500);
  });
});
