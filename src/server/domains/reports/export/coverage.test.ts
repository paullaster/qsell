import { describe, expect, it } from 'vitest';
import { coverageOf } from './coverage';

const AT = '2026-11-25T01:13:00.489Z';

describe('what a download says it covers', () => {
  it('states the days of a period, and the branch', () => {
    expect(
      coverageOf(
        { facts: { fromDate: '2026-10-01', toDate: '2026-10-31', scopeLabel: 'Nairobi branch' } },
        AT,
        'Africa/Nairobi',
      ),
    ).toEqual({ period: '01 Oct 2026 to 31 Oct 2026', scope: 'Nairobi branch' });
  });

  it('gives a single day once', () => {
    expect(
      coverageOf({ facts: { fromDate: '2026-10-05', toDate: '2026-10-05' } }, AT, 'UTC').period,
    ).toBe('05 Oct 2026');
  });

  it('states the time for a report of a position, in the business time zone', () => {
    expect(
      coverageOf(
        { facts: { fromDate: '2026-10-01', toDate: '2026-10-31', asAtNow: true, scopeLabel: 'All locations' } },
        AT,
        'Africa/Nairobi',
      ),
    ).toEqual({ period: 'As at 25 Nov 2026, 04:13', scope: 'All locations' });
  });

  it('falls back to the time when the report carries no facts or odd ones', () => {
    expect(coverageOf({ rows: [] }, AT, 'Africa/Nairobi').period).toBe('As at 25 Nov 2026, 04:13');
    expect(
      coverageOf({ facts: { fromDate: 'soon', toDate: 'later' } }, AT, 'Africa/Nairobi').period,
    ).toBe('As at 25 Nov 2026, 04:13');
  });
});
