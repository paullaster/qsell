import { describe, expect, it } from 'vitest';
import { returnInput, returnProblem, type ReturnForm } from './refund-return-form';

const ok: ReturnForm = { amount: '', reference: ' BNK-1 ', returnedOn: '2026-10-17', intoMethodId: 'm1', reasonCode: 'OTHER', reasonText: '  wrong account ', replacementMethodId: 'm2', replacementDetails: { phone: '0711' } };

describe('the money-came-back form', () => {
  it('accepts a complete form, with the amount left empty for everything', () => {
    expect(returnProblem(ok, '580.00', '2026-10-17')).toBeNull();
    expect(returnProblem({ ...ok, amount: '100' }, '580.00', '2026-10-17')).toBeNull();
  });

  it('says what is missing, one thing at a time', () => {
    expect(returnProblem({ ...ok, amount: '0' }, '580.00', '2026-10-17')).toContain('more than zero');
    expect(returnProblem({ ...ok, amount: '581' }, '580.00', '2026-10-17')).toContain('Only 580.00');
    expect(returnProblem({ ...ok, reference: ' ' }, '580.00', '2026-10-17')).toContain('reference');
    expect(returnProblem({ ...ok, returnedOn: '2026-10-18' }, '580.00', '2026-10-17')).toContain('future');
    expect(returnProblem({ ...ok, intoMethodId: null }, '580.00', '2026-10-17')).toContain('came back into');
    expect(returnProblem({ ...ok, reasonCode: null }, '580.00', '2026-10-17')).toContain('why');
    expect(returnProblem({ ...ok, replacementMethodId: null }, '580.00', '2026-10-17')).toContain('paid this time');
  });

  it('sends trimmed text and no amount when none was typed', () => {
    expect(returnInput(ok)).toEqual({ amount: undefined, returnedOn: '2026-10-17', reference: 'BNK-1', receivedIntoMethodId: 'm1', reasonCode: 'OTHER', reasonText: 'wrong account', replacement: { paymentMethodId: 'm2', payoutDetails: { phone: '0711' } } });
    expect(returnInput({ ...ok, amount: ' 50 ', reasonText: ' ' })).toMatchObject({ amount: '50', reasonText: undefined });
  });
});
