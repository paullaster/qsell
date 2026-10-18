import { describe, expect, it } from 'vitest';
import { formatBusinessTime } from './business-date';

describe('formatBusinessTime', () => {
  it('writes the instant in the business timezone, not the machine timezone', () => {
    const instant = new Date('2026-10-18T14:00:00.000Z');
    expect(formatBusinessTime(instant, 'Africa/Nairobi')).toBe('18 Oct 2026, 17:00');
    expect(formatBusinessTime(instant, 'UTC')).toBe('18 Oct 2026, 14:00');
  });
});