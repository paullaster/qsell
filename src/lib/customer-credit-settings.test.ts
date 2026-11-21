import { describe, expect, it } from 'vitest';
import {
  CREDIT_LIMIT_DISPLAYS,
  DEFAULT_ALLOW_OVER_CREDIT_LIMIT,
  DEFAULT_CREDIT_LIMIT_DISPLAY,
  creditLimitDisplayLabel,
  displayedAvailableCredit,
  isCreditLimitDisplay,
} from './customer-credit-settings';

describe('customer credit settings', () => {
  it('defaults to running display and no over-limit sales', () => {
    expect(DEFAULT_CREDIT_LIMIT_DISPLAY).toBe('running');
    expect(DEFAULT_ALLOW_OVER_CREDIT_LIMIT).toBe(false);
  });

  it('only accepts the two display choices', () => {
    expect(isCreditLimitDisplay('running')).toBe(true);
    expect(isCreditLimitDisplay('static')).toBe(true);
    expect(isCreditLimitDisplay('')).toBe(false);
    expect(isCreditLimitDisplay('RUNNING')).toBe(false);
  });

  it('offers both choices with words for the screen', () => {
    expect(CREDIT_LIMIT_DISPLAYS.map((d) => d.id)).toEqual(['running', 'static']);
    expect(creditLimitDisplayLabel('running')).toBe('Running');
    expect(creditLimitDisplayLabel('static')).toBe('Static');
  });

  it('shows running availability after customer credits reduce what is owed', () => {
    expect(displayedAvailableCredit(1_000_000, 36_000, 'running')).toBe(964_000);
  });

  it('shows only the set limit in static mode', () => {
    expect(displayedAvailableCredit(1_000_000, 36_000, 'static')).toBe(1_000_000);
  });

  it('never shows a negative availability', () => {
    expect(displayedAvailableCredit(1_000_000, 1_200_000, 'running')).toBe(0);
  });
});
