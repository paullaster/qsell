import { describe, expect, it } from 'vitest';
import { parseSalesOrderInput } from './sales-order-input';

const customerId = '11111111-1111-4111-8111-111111111111';
const plain = { customerId, lines: [{ productId: 'p1', quantity: 2 }] };

describe('reading a sales order', () => {
  it('reads a plain order and a package line, keeping only ids, counts and choices', () => {
    const ok = parseSalesOrderInput({ ...plain, price: 1, lines: [{ productId: 'p1', quantity: 2, unitPrice: 1 }, { productId: 'pk', quantity: 12, package: { picks: [{ slotName: 'Fish', productId: 'f', name: 'Large fish', count: 1 }], note: ' no pepper ' } }], neededOn: '2030-05-04', holdUntilPaid: true });
    expect(ok.ok && ok.input).toEqual({
      customerId,
      lines: [{ productId: 'p1', quantity: 2 }, { productId: 'pk', quantity: 12, package: { picks: [{ slotName: 'Fish', productId: 'f', name: 'Large fish', count: 1 }], note: 'no pepper' } }],
      paymentMethod: 'mpesa_daraja',
      neededOn: '2030-05-04',
      holdUntilPaid: true,
    });
  });

  it('needs a real customer and at least one line', () => {
    expect(parseSalesOrderInput({ ...plain, customerId: 'x' })).toEqual({ ok: false, error: 'Choose the customer.' });
    expect(parseSalesOrderInput({ ...plain, lines: [] })).toEqual({ ok: false, error: 'Add something to sell.' });
    expect(parseSalesOrderInput({ ...plain, paymentMethod: 'on_account' })).toEqual({ ok: false, error: 'Choose how the customer will pay.' });
    expect(parseSalesOrderInput({ ...plain, paymentMethod: 'kcb_buni' }).ok).toBe(true);
    expect(parseSalesOrderInput(null).ok).toBe(false);
  });

  it('refuses a quantity of nothing, too many, or not a number, and a package in a part of a serving', () => {
    for (const quantity of [0, -1, 1e9, Number.NaN, '2']) expect(parseSalesOrderInput({ ...plain, lines: [{ productId: 'p1', quantity }] }).ok).toBe(false);
    const picks = [{ slotName: 'Fish', productId: 'f', name: 'x', count: 1 }];
    expect(parseSalesOrderInput({ ...plain, lines: [{ productId: 'pk', quantity: 1.5, package: { picks } }] })).toEqual({ ok: false, error: 'Line 1: a package is sold in whole servings.' });
    expect(parseSalesOrderInput({ ...plain, lines: [{ productId: 'pk', quantity: 2, package: { picks: [] } }] }).ok).toBe(false);
    expect(parseSalesOrderInput({ ...plain, lines: [{ productId: 'pk', quantity: 2, package: { picks: [{ slotName: 'Fish', productId: 'f', count: 0 }] } }] }).ok).toBe(false);
  });

  it('refuses a date that is not one, and bounds the number of lines', () => {
    expect(parseSalesOrderInput({ ...plain, neededOn: '2027-02-31' })).toEqual({ ok: false, error: 'That is not a date.' });
    expect(parseSalesOrderInput({ ...plain, lines: Array.from({ length: 101 }, () => ({ productId: 'p', quantity: 1 })) }).ok).toBe(false);
  });
});
