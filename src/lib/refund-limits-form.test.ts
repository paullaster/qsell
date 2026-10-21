import { describe, expect, it } from 'vitest';
import { NO_LIMITS } from '@/server/domains/finance/domain/refund-limits';
import { checkLimitsForm, type LimitsForm } from './refund-limits-form';

describe('the limits form', () => {
  const form = (over: Partial<LimitsForm> = {}): LimitsForm => ({
    enabled: true,
    windowHours: '24',
    maxPerCustomer: '2',
    maxAmountPerCustomer: '',
    maxPerDestination: '',
    maxPerRequester: '',
    maxAmountPerRequester: '',
    mode: 'review',
    ...over,
  });

  it('turns what was typed into limits, leaving empty ones unlimited', () => {
    expect(checkLimitsForm(form({ maxAmountPerCustomer: '1,500.50' }))).toEqual({
      ok: true,
      value: { ...NO_LIMITS, enabled: true, maxPerCustomer: 2, maxCentsPerCustomer: 150_050 },
    });
  });
  it('refuses nonsense in words', () => {
    expect(checkLimitsForm(form({ windowHours: '0' }))).toMatchObject({ ok: false });
    expect(checkLimitsForm(form({ windowHours: '721' }))).toMatchObject({ ok: false });
    expect(checkLimitsForm(form({ maxPerCustomer: '0' }))).toMatchObject({
      ok: false,
      error: expect.stringContaining('Refunds per customer'),
    });
    expect(checkLimitsForm(form({ maxAmountPerRequester: '-5' }))).toMatchObject({ ok: false });
    expect(checkLimitsForm(form({ mode: 'ignore' }))).toMatchObject({ ok: false });
  });
  it('wants at least one limit when switched on, but lets everything be empty when off', () => {
    expect(checkLimitsForm(form({ maxPerCustomer: '' }))).toMatchObject({
      ok: false,
      error: 'Set at least one limit, or switch the limits off.',
    });
    expect(checkLimitsForm(form({ enabled: false, maxPerCustomer: '' }))).toMatchObject({
      ok: true,
    });
  });
});
