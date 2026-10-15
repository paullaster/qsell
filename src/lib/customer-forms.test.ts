import { describe, expect, it } from 'vitest';
import { accountTypeOf, blockOf, emptyCustomerForm, isAccountType, labelOfAccountType, newCustomerPayload } from './customer-forms';

const filled = (over: Partial<ReturnType<typeof emptyCustomerForm>> = {}) => ({ ...emptyCustomerForm(), name: '  Jane Doe ', ...over });

describe('customer forms', () => {
  it('reads stored values safely', () => {
    expect(accountTypeOf('credit')).toBe('credit');
    expect(accountTypeOf('weird')).toBe('cash');
    expect(blockOf('all')).toBe('all');
    expect(blockOf(null)).toBe('none');
    expect(isAccountType('cash')).toBe(true);
    expect(isAccountType('x')).toBe(false);
    expect(labelOfAccountType('credit')).toMatch(/Credit/);
  });

  it('needs a name and tidies what it is given', () => {
    expect(newCustomerPayload(emptyCustomerForm())).toEqual({ ok: false, error: 'Customer name is required.' });
    const r = newCustomerPayload(filled({ email: ' Jane@Example.COM ', phone: ' 0712 ', buyerKraPin: 'a123456789z' }));
    expect(r).toMatchObject({ ok: true, payload: { name: 'Jane Doe', email: 'jane@example.com', phone: '0712', buyerKraPin: 'A123456789Z', creditLimit: 0, paymentTermDays: 0, profileId: null } });
  });

  it('refuses a bad email or KRA PIN with words', () => {
    const errorOf = (r: ReturnType<typeof newCustomerPayload>) => (r.ok ? '' : r.error);
    expect(errorOf(newCustomerPayload(filled({ email: 'nope' })))).toMatch(/email/i);
    expect(errorOf(newCustomerPayload(filled({ buyerKraPin: '12345' })))).toMatch(/KRA PIN/);
  });

  it('keeps credit terms for credit customers only', () => {
    expect(newCustomerPayload(filled({ accountType: 'cash', creditLimit: '500', paymentTermDays: '30' }))).toMatchObject({ ok: true, payload: { creditLimit: 0, paymentTermDays: 0 } });
    expect(newCustomerPayload(filled({ accountType: 'credit', creditLimit: '0' }))).toMatchObject({ ok: false });
    expect(newCustomerPayload(filled({ accountType: 'credit', creditLimit: '500', paymentTermDays: '1.5' }))).toMatchObject({ ok: false });
    expect(newCustomerPayload(filled({ accountType: 'credit', creditLimit: '500', paymentTermDays: '30' }))).toMatchObject({ ok: true, payload: { creditLimit: 500, paymentTermDays: 30 } });
  });
});
