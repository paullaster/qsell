import { describe, expect, it } from 'vitest';
import { readVanReturn, returnProblem } from './returns';

const visitId = '9f1c7e1e-3b0a-4a8e-8d6b-2b4f6f0a1c11';
const key = '3f2c7e1e-3b0a-4a8e-8d6b-2b4f6f0a1c22';
const method = '5f2c7e1e-3b0a-4a8e-8d6b-2b4f6f0a1c33';
const base = { visitId, orderId: 'ord_1', lines: [{ productId: 'prod_a', quantity: 2 }], reason: { code: 'POLICY_CHANGE', text: ' changed  their mind ' }, restock: true, refund: { methodId: method, phone: '' }, key };

describe('reading a return', () => {
  it('reads the visit, the sale, the lines, the reason, whether the goods can be sold again and how the customer is paid back', () => {
    expect(readVanReturn(base)).toEqual({ ok: true, ret: { visitId, orderId: 'ord_1', lines: [{ productId: 'prod_a', quantity: 2 }], reason: { code: 'POLICY_CHANGE', text: 'changed their mind' }, restock: true, refund: { methodId: method, phone: '' }, key } });
    expect(readVanReturn({ ...base, restock: undefined })).toMatchObject({ ok: true, ret: { restock: false } });
  });
  it('refuses what cannot be a return', () => {
    expect(readVanReturn(null)).toMatchObject({ ok: false });
    expect(readVanReturn({ ...base, visitId: 'x' })).toMatchObject({ ok: false, error: expect.stringContaining('visit') as string });
    expect(readVanReturn({ ...base, orderId: '' })).toMatchObject({ ok: false, error: expect.stringContaining('sale') as string });
    expect(readVanReturn({ ...base, key: 'x' })).toMatchObject({ ok: false, error: expect.stringContaining('told apart') as string });
    expect(readVanReturn({ ...base, lines: [] })).toMatchObject({ ok: false });
    expect(readVanReturn({ ...base, lines: [{ productId: 'a', quantity: 0 }] })).toMatchObject({ ok: false });
    expect(readVanReturn({ ...base, lines: [{ productId: 'a', quantity: 1 }, { productId: 'a', quantity: 1 }] })).toMatchObject({ ok: false, error: expect.stringContaining('once') as string });
    expect(readVanReturn({ ...base, reason: {} })).toMatchObject({ ok: false, error: expect.stringContaining('why') as string });
    expect(readVanReturn({ ...base, refund: { methodId: 'x' } })).toMatchObject({ ok: false, error: expect.stringContaining('paid back') as string });
  });
});

describe('when a return can be taken', () => {
  const ok = { dayStatus: 'out', visitStatus: 'arrived', customerName: 'Duka', saleIsCustomers: true, saleOnThisVan: true };
  it('needs the day out, the rep at the customer, and a sale of this customer made from this van', () => {
    expect(returnProblem(ok)).toBeNull();
    expect(returnProblem({ ...ok, dayStatus: 'loading' })).toContain('while the day is out');
    expect(returnProblem({ ...ok, visitStatus: 'planned' })).toContain('Arrive at Duka');
    expect(returnProblem({ ...ok, saleIsCustomers: false })).toContain('not made to Duka');
    expect(returnProblem({ ...ok, saleOnThisVan: false })).toContain('not made from this van');
  });
});
