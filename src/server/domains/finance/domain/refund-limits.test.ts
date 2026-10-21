import { describe, expect, it } from 'vitest';
import {
  checkVelocity,
  destinationOf,
  NO_LIMITS,
  type RefundLimitValues,
  type VelocityUsage,
} from './refund-limits';

const on = (over: Partial<RefundLimitValues> = {}): RefundLimitValues => ({
  ...NO_LIMITS,
  enabled: true,
  ...over,
});
const none: VelocityUsage = {
  customer: { count: 0, cents: 0 },
  destination: { count: 0 },
  requester: { count: 0, cents: 0 },
};

describe('refund velocity', () => {
  it('finds nothing when limits are off, or when nothing is past a limit', () => {
    expect(
      checkVelocity(
        { ...NO_LIMITS, maxPerCustomer: 1 },
        { ...none, customer: { count: 5, cents: 0 } },
        100,
      ),
    ).toEqual([]);
    expect(
      checkVelocity(on({ maxPerCustomer: 2 }), { ...none, customer: { count: 1, cents: 0 } }, 100),
    ).toEqual([]);
  });

  it('counts the refund being asked for: the third is past a limit of two', () => {
    const out = checkVelocity(
      on({ maxPerCustomer: 2 }),
      { ...none, customer: { count: 2, cents: 0 } },
      100,
    );
    expect(out).toEqual(['This customer would have 3 refunds in a day; the limit is 2.']);
  });

  it('limits what a customer and a person may refund in money', () => {
    const out = checkVelocity(
      on({ maxCentsPerCustomer: 100_000, maxCentsPerRequester: 500_000, windowHours: 48 }),
      { ...none, customer: { count: 1, cents: 90_000 }, requester: { count: 4, cents: 450_000 } },
      20_000,
    );
    expect(out[0]).toBe(
      'This customer would be refunded 1,100.00 in 2 days; the limit is 1,000.00.',
    );
    expect(out).toHaveLength(1);
  });

  it('limits how often one phone or account is paid, but only when there is a destination', () => {
    expect(
      checkVelocity(on({ maxPerDestination: 1 }), { ...none, destination: { count: 1 } }, 100),
    ).toEqual(['This phone number or account would be paid 2 refunds in a day; the limit is 1.']);
    expect(
      checkVelocity(on({ maxPerDestination: 1 }), { ...none, destination: null }, 100),
    ).toEqual([]);
  });

  it('says every limit that is passed', () => {
    const out = checkVelocity(
      on({ maxPerCustomer: 1, maxPerRequester: 1 }),
      { ...none, customer: { count: 1, cents: 0 }, requester: { count: 1, cents: 0 } },
      100,
    );
    expect(out).toHaveLength(2);
  });

  it('words hours and days', () => {
    expect(
      checkVelocity(
        on({ maxPerCustomer: 1, windowHours: 1 }),
        { ...none, customer: { count: 1, cents: 0 } },
        1,
      )[0],
    ).toContain('in an hour');
    expect(
      checkVelocity(
        on({ maxPerCustomer: 1, windowHours: 6 }),
        { ...none, customer: { count: 1, cents: 0 } },
        1,
      )[0],
    ).toContain('in 6 hours');
    expect(
      checkVelocity(
        on({ maxPerCustomer: 1, windowHours: 168 }),
        { ...none, customer: { count: 1, cents: 0 } },
        1,
      )[0],
    ).toContain('in 7 days');
  });
});

describe('where a refund goes', () => {
  it('is a phone by its last nine digits, however it was typed', () => {
    expect(destinationOf('mobile_money', { phone: '+254 712 345 678' })).toEqual({
      field: 'phone',
      value: '712345678',
    });
    expect(destinationOf('mobile_money', { phone: '0712345678' })).toEqual({
      field: 'phone',
      value: '712345678',
    });
    expect(destinationOf('mobile_money', { phone: '123' })).toBeNull();
  });
  it('is a bank account number, and nothing for cash or cheque', () => {
    expect(destinationOf('bank_transfer', { accountNumber: '01 234 567' })).toEqual({
      field: 'accountNumber',
      value: '01234567',
    });
    expect(destinationOf('cash', { recipientName: 'Al' })).toBeNull();
    expect(destinationOf('cheque', { payeeName: 'Al' })).toBeNull();
  });
});
