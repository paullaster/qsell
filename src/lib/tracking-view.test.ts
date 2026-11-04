import { describe, expect, it } from 'vitest';
import { DELIVERY_STATUSES } from './delivery-document';
import { CUSTOMER_STATUS_WORDS, HEADLINE, collectionWords, customerTone, trackingSteps } from './tracking-view';

describe('what the customer sees', () => {
  it('has words for every state a delivery can be in, and they are never the dispatcher’s words', () => {
    for (const s of DELIVERY_STATUSES) expect(CUSTOMER_STATUS_WORDS[s].length).toBeGreaterThan(3);
    expect(CUSTOMER_STATUS_WORDS.picking).toBe('Being prepared');
    expect(CUSTOMER_STATUS_WORDS.out_for_delivery).toBe('On its way');
    expect(Object.values(HEADLINE)).toHaveLength(5);
  });
  it('tones delivered as good, a failed or returned one as needing attention, and a cancelled one as ended', () => {
    expect(customerTone('delivered')).toBe('good');
    expect(customerTone('failed_attempt')).toBe('attention');
    expect(customerTone('returned')).toBe('attention');
    expect(customerTone('cancelled')).toBe('ended');
    expect(customerTone('out_for_delivery')).toBe('progress');
  });
  it('shows the steps a delivery has been through, with the one it is at', () => {
    const mark = (x: { done: boolean; current: boolean }): string => {
      if (x.done) return '✓';
      return x.current ? '•' : ' ';
    };
    const at = (s: Parameters<typeof trackingSteps>[0]) => trackingSteps(s).map((x) => `${mark(x)}${x.label}`).join(' | ');
    expect(at('picking')).toBe('•Being prepared |  Ready to go |  On its way |  Delivered');
    expect(at('ready')).toBe('✓Being prepared | •Ready to go |  On its way |  Delivered');
    expect(at('out_for_delivery')).toBe('✓Being prepared | ✓Ready to go | •On its way |  Delivered');
    expect(at('delivered')).toBe('✓Being prepared | ✓Ready to go | ✓On its way | ✓Delivered');
    expect(trackingSteps('cancelled').some((x) => x.current)).toBe(false);
  });
  it('shows a delivery that could not be made at the step where it stopped', () => {
    expect(trackingSteps('failed_attempt').find((x) => x.current)?.label).toBe('On its way');
    expect(trackingSteps('failed_attempt').find((x) => x.label === 'Delivered')?.done).toBe(false);
  });
});

describe('an order that is collected', () => {
  it('says where, in each state, and never mentions the code', () => {
    for (const status of ['waiting', 'ready', 'collected', 'locked', 'cancelled'] as const) {
      const w = collectionWords({ branchName: 'Westlands Branch', status });
      expect(w.headline.length).toBeGreaterThan(5);
      expect(w.detail).toContain('Westlands Branch');
      expect(`${w.headline} ${w.detail}`).not.toMatch(/\bcode is\b|[A-Z0-9]{6}/);
    }
    expect(collectionWords({ branchName: 'X', status: 'ready' }).headline).toBe('Your order is ready to collect');
  });
});
