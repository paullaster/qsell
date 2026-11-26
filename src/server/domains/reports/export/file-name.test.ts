import { describe, expect, it } from 'vitest';
import { exportFileName, fileStamp, slugOf } from './file-name';

describe('export file names', () => {
  it('names the business, the report and the moment, in that order', () => {
    expect(
      exportFileName({
        business: 'SM Engineering Limited',
        report: 'Stock valuation',
        now: new Date('2026-11-25T01:13:00.489Z'),
        timeZone: 'Africa/Nairobi',
        extension: 'pdf',
      }),
    ).toBe('sm-engineering-limited_stock-valuation_20261125-041300.pdf');
  });

  it('stamps in the business time zone, so a late evening is still that day', () => {
    expect(fileStamp(new Date('2026-12-31T22:30:05Z'), 'Africa/Nairobi')).toBe('20270101-013005');
    expect(fileStamp(new Date('2026-12-31T22:30:05Z'), 'UTC')).toBe('20261231-223005');
  });

  it('keeps only letters, digits and hyphens, and always leaves something', () => {
    expect(slugOf('../../etc/passwd', 'x')).toBe('etc-passwd');
    expect(slugOf('Ñandi "quote"\r\nHeader: x', 'x')).toBe('nandi-quote-header-x');
    expect(slugOf('!!!', 'business')).toBe('business');
    expect(slugOf('a'.repeat(200), 'x', 40)).toHaveLength(40);
  });

  it('falls back to words when the business name has no letters in it', () => {
    expect(
      exportFileName({
        business: '東京',
        report: 'Receivables ageing',
        now: new Date('2026-03-10T12:00:00Z'),
        timeZone: 'UTC',
        extension: 'csv',
      }),
    ).toBe('business_receivables-ageing_20260310-120000.csv');
  });
});
