import { describe, expect, it } from 'vitest';
import { deliveryCreditTarget, goodsInvoiceTotal, isDeliveryLine } from './delivery-credit';

const money = { gross: 116, net: 100, tax: 16 };

describe('deliveryCreditTarget', () => {
  it('follows how the invoice was issued', () => {
    expect(deliveryCreditTarget({ mode: 'with_goods', serviceProductId: 'svc' }, money)).toMatchObject({ mode: 'with_goods', productId: 'svc', gross: 116 });
    expect(deliveryCreditTarget({ mode: 'separate', serviceProductId: 'svc' }, money)?.mode).toBe('separate');
  });

  it('has nothing to credit without a layout, an item or a charge', () => {
    expect(deliveryCreditTarget(null, money)).toBeNull();
    expect(deliveryCreditTarget({ mode: 'with_goods', serviceProductId: null }, money)).toBeNull();
    expect(deliveryCreditTarget({ mode: 'with_goods', serviceProductId: 'svc' }, null)).toBeNull();
    expect(deliveryCreditTarget({ mode: 'with_goods', serviceProductId: 'svc' }, { gross: 0, net: 0, tax: 0 })).toBeNull();
  });
});

describe('goodsInvoiceTotal', () => {
  const together = deliveryCreditTarget({ mode: 'with_goods', serviceProductId: 'svc' }, money);
  const apart = deliveryCreditTarget({ mode: 'separate', serviceProductId: 'svc' }, money);

  it('is the whole order when delivery is on it, and less delivery when it has its own invoice', () => {
    expect(goodsInvoiceTotal(1116, together)).toBe(1116);
    expect(goodsInvoiceTotal(1116, apart)).toBe(1000);
    expect(goodsInvoiceTotal(1116, null)).toBe(1116);
  });

  it('knows which line is delivery only when it is a line of the goods invoice', () => {
    expect(isDeliveryLine('svc', together)).toBe(true);
    expect(isDeliveryLine('other', together)).toBe(false);
    expect(isDeliveryLine('svc', apart)).toBe(false);
  });
});
