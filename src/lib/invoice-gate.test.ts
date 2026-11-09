import { describe, expect, it } from 'vitest';
import { taxInvoiceRefusal } from './invoice-gate';

const order = (over: Partial<Parameters<typeof taxInvoiceRefusal>[0]>) => ({ status: 'processing', paymentStatus: 'paid', paymentMethod: 'mpesa_daraja', ...over });

describe('who may be given a tax invoice', () => {
  it('a paid order, and one on account or to be paid on delivery', () => {
    expect(taxInvoiceRefusal(order({}))).toBeNull();
    expect(taxInvoiceRefusal(order({ paymentStatus: 'unpaid', paymentMethod: 'on_account' }))).toBeNull();
    expect(taxInvoiceRefusal(order({ paymentStatus: 'unpaid', paymentMethod: 'pay_on_delivery' }))).toBeNull();
  });
  it('not an order that was never paid', () => {
    for (const paymentStatus of ['unpaid', 'pending_verification', 'failed']) expect(taxInvoiceRefusal(order({ paymentStatus }))).not.toBeNull();
  });
  it('not one that was cancelled or failed, whatever its payment says', () => {
    expect(taxInvoiceRefusal(order({ status: 'cancelled' }))).not.toBeNull();
    expect(taxInvoiceRefusal(order({ status: 'failed', paymentMethod: 'on_account' }))).not.toBeNull();
  });
});
