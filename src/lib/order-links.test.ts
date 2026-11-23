import { describe, expect, it } from 'vitest';
import { invoiceHref, orderChannel, orderHref, parseOrderTarget } from './order-links';

describe('order links', () => {
  it('builds the address of one order and of its invoice', () => {
    expect(orderHref('ord_1a-2')).toBe('/admin/orders/view/ord_1a-2');
    expect(invoiceHref('ord_1a-2')).toBe('/admin/orders/view/ord_1a-2?invoice=1');
  });

  it('reads them back', () => {
    expect(parseOrderTarget({ order: 'ord_1a-2' })).toEqual({ orderId: 'ord_1a-2', invoice: false });
    expect(parseOrderTarget({ order: 'ord_1a-2', invoice: '1' })).toEqual({ orderId: 'ord_1a-2', invoice: true });
  });

  it('ignores an id that is not shaped like one, and an invoice flag with no order', () => {
    expect(parseOrderTarget({ order: "x'; drop table orders;--" })).toEqual({ orderId: null, invoice: false });
    expect(parseOrderTarget({ order: ['a', 'b'] })).toEqual({ orderId: null, invoice: false });
    expect(parseOrderTarget({ invoice: '1' })).toEqual({ orderId: null, invoice: false });
    expect(parseOrderTarget({ order: 'a'.repeat(101) })).toEqual({ orderId: null, invoice: false });
  });

  it('names the kind of order and the screen it belongs to', () => {
    expect(orderChannel('sales_order')).toEqual({ kind: 'Sales order', homeHref: '/admin/sales-orders', homeName: 'Sales Orders' });
    expect(orderChannel('credit_sale').homeHref).toBe('/admin/credit-sales');
    expect(orderChannel('sales_invoice').homeHref).toBe('/admin/sales-invoices');
    expect(orderChannel('pos_cash_sale').homeHref).toBe('/admin/cash-sales');
    for (const old of [undefined, null, 'ecommerce', 'something_new']) expect(orderChannel(old).homeHref).toBe('/admin/orders');
  });
});
