import { describe, expect, it } from 'vitest';
import type { SalesOrderInput } from './domain/sales-order-input';

// holdToRights is imported lazily: line-rights pulls in the container, which a unit test does not need.
const doc = (lines: SalesOrderInput['lines']): SalesOrderInput => ({ customerId: 'c', lines, paymentMethod: 'mpesa_daraja', neededOn: '', holdUntilPaid: false });

describe('holdToRights', async () => {
  const { holdToRights } = await import('./line-rights');
  const priced = doc([{ productId: 'p', quantity: 1, unitPrice: 90 }]);
  const discounted = doc([{ productId: 'p', quantity: 1, discount: { kind: 'percent', value: 5 } }]);

  it('keeps a typed price for someone who may change prices and drops it for anyone else', () => {
    expect(holdToRights({ canPrice: true, canDiscount: false, discountSwitchedOff: false }, priced)).toEqual({ ok: true, input: priced });
    const dropped = holdToRights({ canPrice: false, canDiscount: false, discountSwitchedOff: false }, priced);
    expect(dropped.ok && dropped.input.lines[0]).toEqual({ productId: 'p', quantity: 1 });
  });

  it('refuses a discount in words, never dropping it, from someone who may not give one here', () => {
    const refused = holdToRights({ canPrice: true, canDiscount: false, discountSwitchedOff: false }, discounted);
    expect(refused.ok).toBe(false);
    expect(refused.ok ? '' : refused.error).toContain('cannot give a discount');
    expect(holdToRights({ canPrice: false, canDiscount: true, discountSwitchedOff: false }, discounted)).toEqual({ ok: true, input: discounted });
  });
});
