import { describe, expect, it } from 'vitest';
import { NO_LIMITS } from './rep-limits';
import { creditAmountProblem, paymentState, readSale, repSaleProblem, saleLinesOf, tendersOf, type SaleLine } from './sell';

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const key = '11111111-1111-4111-8111-111111111111';
const cash = { visitId: id(1), kind: 'cash', saleKey: key, lines: [{ productId: 'prod_a', quantity: 2 }], tenders: [{ methodId: id(2), amount: 200, reference: '' }] };
const limits = { maxDiscountPercent: 5, maxCreditPerDay: 10_000, mayOverridePrice: false, maySellOnCredit: true };

describe('reading a sale', () => {
  it('takes a cash sale with its lines and how it is paid, and a sale on account with no payment', () => {
    expect(readSale(cash)).toEqual({ ok: true, sale: { visitId: id(1), kind: 'cash', saleKey: key, lines: [{ productId: 'prod_a', quantity: 2 }], tenders: [{ methodId: id(2), amount: 200, reference: '' }] } });
    expect(readSale({ ...cash, kind: 'credit', tenders: undefined })).toMatchObject({ ok: true, sale: { kind: 'credit', tenders: [] } });
  });
  it('reads a typed price and a percentage discount, rounded to cents', () => {
    const r = readSale({ ...cash, lines: [{ productId: 'prod_a', quantity: 1.5, unitPrice: '99.999', discount: { kind: 'percent', value: '2.505' } }] });
    expect(r).toMatchObject({ ok: true, sale: { lines: [{ productId: 'prod_a', quantity: 1.5, unitPrice: 100, discount: { kind: 'percent', value: 2.51 } }] } });
  });
  it.each([
    [null, 'could not be read'],
    [{ ...cash, visitId: 'x' }, 'Choose the visit'],
    [{ ...cash, kind: 'barter' }, 'paid now or on the customer'],
    [{ ...cash, saleKey: 'nope' }, 'told apart'],
    [{ ...cash, lines: [] }, 'Add something to sell'],
    [{ ...cash, lines: [{ productId: '', quantity: 1 }] }, 'Line 1: choose a product'],
    [{ ...cash, lines: [{ productId: 'a', quantity: 0 }] }, 'Line 1: the quantity'],
    [{ ...cash, lines: [{ productId: 'a', quantity: 1 }, { productId: 'b', quantity: 'many' }] }, 'Line 2: the quantity'],
    [{ ...cash, lines: [{ productId: 'a', quantity: 1, unitPrice: -3 }] }, 'the price must be more than nothing'],
    [{ ...cash, lines: [{ productId: 'a', quantity: 1, discount: { kind: 'amount', value: 5 } }] }, 'a percentage'],
    [{ ...cash, lines: [{ productId: 'a', quantity: 1, discount: { kind: 'percent', value: 100 } }] }, 'between 0 and 100'],
    [{ ...cash, tenders: [] }, 'how the customer pays'],
    [{ ...cash, tenders: [{ methodId: 'x', amount: 1, reference: '' }] }, 'from the list'],
    [{ ...cash, tenders: [{ methodId: id(2), amount: 0, reference: '' }] }, 'more than nothing'],
    [{ ...cash, tenders: Array.from({ length: 5 }, () => ({ methodId: id(2), amount: 1, reference: '' })) }, 'at most 4 ways'],
    [{ ...cash, lines: Array.from({ length: 101 }, () => ({ productId: 'a', quantity: 1 })) }, 'at most 100 lines'],
  ])('refuses %j in words', (raw, words) => {
    const r = readSale(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(words);
  });
});

describe('what a rep may do on their own', () => {
  const lines = (...l: SaleLine[]): { kind: 'cash'; lines: SaleLine[] } => ({ kind: 'cash', lines: l });
  it('may sell at the server\'s prices with no discount', () => {
    expect(repSaleProblem(NO_LIMITS, lines({ productId: 'a', quantity: 1 }))).toBeNull();
  });
  it('needs the right to change a price, and a discount within the limit', () => {
    expect(repSaleProblem(limits, lines({ productId: 'a', quantity: 1, unitPrice: 90 }))).toBe('You are not allowed to change a price.');
    expect(repSaleProblem({ ...limits, mayOverridePrice: true }, lines({ productId: 'a', quantity: 1, unitPrice: 90 }))).toBeNull();
    expect(repSaleProblem(limits, lines({ productId: 'a', quantity: 1, discount: { kind: 'percent', value: 5 } }))).toBeNull();
    expect(repSaleProblem(limits, lines({ productId: 'a', quantity: 1, discount: { kind: 'percent', value: 6 } }))).toBe('You may give at most 5% off.');
    expect(repSaleProblem(NO_LIMITS, lines({ productId: 'a', quantity: 1, discount: { kind: 'percent', value: 1 } }))).toBe('You are not allowed to give a discount.');
  });
  it('needs the right to sell on credit, and the amount within the day\'s limit once it is priced', () => {
    expect(repSaleProblem(NO_LIMITS, { kind: 'credit', lines: [{ productId: 'a', quantity: 1 }] })).toBe('You are not allowed to sell on credit.');
    expect(repSaleProblem(limits, { kind: 'credit', lines: [{ productId: 'a', quantity: 1 }] })).toBeNull();
    expect(creditAmountProblem(limits, 4000, 5000)).toBeNull();
    expect(creditAmountProblem(limits, 6000, 5000)).toBe('You may give KES 5,000.00 more credit today.');
  });
});


describe('the sale as it is typed', () => {
  const row = (over: Record<string, string> = {}) => ({ productId: 'prod_a', name: 'Soda', quantity: '2', discount: '', price: '', ...over });
  it('sends only the lines that have a quantity, with a discount or price only where one was typed', () => {
    expect(saleLinesOf([row(), row({ productId: 'prod_b', quantity: '' }), row({ productId: 'prod_c', quantity: '0' }), row({ productId: 'prod_d', quantity: 'x' })])).toEqual([{ productId: 'prod_a', quantity: 2 }]);
    expect(saleLinesOf([row({ discount: '5', price: '90' })])).toEqual([{ productId: 'prod_a', quantity: 2, unitPrice: 90, discount: { kind: 'percent', value: 5 } }]);
    expect(saleLinesOf([row({ discount: '0', price: '-4' })])).toEqual([{ productId: 'prod_a', quantity: 2 }]);
  });
  it('sends only the payments that have an amount and a way of paying', () => {
    expect(tendersOf([{ methodId: 'm1', amount: '200', reference: ' ABC ' }, { methodId: 'm2', amount: '', reference: '' }, { methodId: '', amount: '5', reference: '' }])).toEqual([{ methodId: 'm1', amount: 200, reference: 'ABC' }]);
  });
  it('says what has been paid, how much is short and the change to give', () => {
    expect(paymentState(200, [{ methodId: 'm1', amount: '150', reference: '' }])).toEqual({ paid: 150, short: 50, change: 0 });
    expect(paymentState(200, [{ methodId: 'm1', amount: '100', reference: '' }, { methodId: 'm2', amount: '100', reference: 'QK1' }])).toEqual({ paid: 200, short: 0, change: 0 });
    expect(paymentState(200, [{ methodId: 'm1', amount: '500', reference: '' }])).toEqual({ paid: 500, short: 0, change: 300 });
    expect(paymentState(200, [])).toEqual({ paid: 0, short: 200, change: 0 });
  });
});
