import { describe, expect, it } from 'vitest';
import { MAX_PASTED_FEES, parseRateCardPaste } from './rate-card-paste';

describe('parseRateCardPaste', () => {
  it('reads a spreadsheet copy (tabs) by zone, skipping the header and ignoring blank lines', () => {
    const r = parseRateCardPaste('Zone\tFrom kg\tUp to kg\tFee\tEach extra kg\nnbo-cbd\t0\t5\t250\t\n\nNBO-CBD\t5\t\t1,250.50\t40\n*\t0\t\t900\t', true);
    expect(r.problems).toEqual([]);
    expect(r.fees).toEqual([
      { line: 2, zoneCode: 'NBO-CBD', fromKg: '0', toKg: '5', fee: '250', perExtraKg: '' },
      { line: 4, zoneCode: 'NBO-CBD', fromKg: '5', toKg: '', fee: '1250.50', perExtraKg: '40' },
      { line: 5, zoneCode: null, fromKg: '0', toKg: '', fee: '900', perExtraKg: '' },
    ]);
    expect(r.zoneCodes).toEqual(['NBO-CBD']);
  });

  it('reads a flat card typed with commas or semicolons', () => {
    expect(parseRateCardPaste('0,5,200\n5,no limit,350,20', false).fees).toMatchObject([
      { fromKg: '0', toKg: '5', fee: '200' },
      { fromKg: '5', toKg: '', fee: '350', perExtraKg: '20' },
    ]);
    expect(parseRateCardPaste('0;5;200', false).fees).toMatchObject([{ fromKg: '0', toKg: '5', fee: '200' }]);
    // Without tabs a comma is a separator, never a thousands mark, so "1,200" is not read as 1200.
    const r = parseRateCardPaste('0;5;1,200', false);
    expect(r.fees).toEqual([]);
    expect(r.problems[0]?.message).toMatch(/Fee/);
  });

  it('strips a currency word in front of an amount', () => {
    expect(parseRateCardPaste('0\t\tKES 1,200', false).fees[0]?.fee).toBe('1200');
  });

  it('says which line is wrong and why, and still reads the good ones', () => {
    const r = parseRateCardPaste('0,5,200\n5,3,300\nx,,100\n0,,abc\n7', false);
    expect(r.fees).toHaveLength(1);
    expect(r.problems.map((p) => p.line)).toEqual([2, 3, 4, 5]);
    expect(r.problems[0]?.message).toMatch(/more than "from kg"/);
    expect(r.problems[3]?.message).toMatch(/Needs from kg/);
  });

  it('does not take a data line for a header just because its zone is words', () => {
    expect(parseRateCardPaste('CBD,0,5,200', true).fees).toHaveLength(1);
  });

  it('stops at the limit and says so', () => {
    const many = Array.from({ length: MAX_PASTED_FEES + 5 }, (_, i) => `${String(i)},${String(i + 1)},10`).join('\n');
    const r = parseRateCardPaste(many, false);
    expect(r.fees).toHaveLength(MAX_PASTED_FEES);
    expect(r.truncated).toBe(true);
  });

  it('reads nothing from nothing', () => {
    expect(parseRateCardPaste('  \n\n', true)).toEqual({ fees: [], problems: [], truncated: false, zoneCodes: [] });
  });
});
