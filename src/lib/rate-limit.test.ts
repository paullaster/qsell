import { describe, expect, it } from 'vitest';
import { RATE_RULES, clientAddress, decide, scaledRule, waitMessage, windowStart } from './rate-limit';

describe('request limits', () => {
  it('puts every moment in one window that all instances agree on', () => {
    expect(windowStart(1_000_000_000_000, 900)).toBe(windowStart(1_000_000_000_000 + 5_000, 900));
    expect(windowStart(900_000, 900)).toBe(900);
    expect(windowStart(899_999, 900)).toBe(0);
  });
  it('allows up to the limit and then says how long to wait', () => {
    const rule = RATE_RULES.login_account;
    expect(decide(rule.limit, rule, 0).allowed).toBe(true);
    const blocked = decide(rule.limit + 1, rule, 100_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(800);
  });
  it('words the wait plainly', () => {
    expect(waitMessage(30)).toMatch(/a minute/);
    expect(waitMessage(600)).toMatch(/10 minutes/);
    expect(waitMessage(100_000)).toMatch(/later/);
  });
  it('trusts the proxy header and the nearest forwarded address, never the first', () => {
    expect(clientAddress('10.0.0.1', '1.2.3.4, 10.0.0.1')).toBe('10.0.0.1');
    expect(clientAddress(null, '6.6.6.6, 10.0.0.9')).toBe('10.0.0.9');
    expect(clientAddress(null, null)).toBe('unknown');
    expect(clientAddress('x'.repeat(100), null)).toBe('unknown');
  });
  it('scales limits for test servers only, never in production', () => {
    const rule = { limit: 8, seconds: 900 };
    expect(scaledRule(rule, '50', false).limit).toBe(400);
    expect(scaledRule(rule, '50', true)).toEqual(rule);
    expect(scaledRule(rule, 'lots', false)).toEqual(rule);
    expect(scaledRule(rule, '0.1', false)).toEqual(rule);
  });
});
