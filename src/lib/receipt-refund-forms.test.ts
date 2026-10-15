import { describe, expect, it } from 'vitest';
import { amountHint, customerStanding, isForeign, methodTraits, postOptions, receiptInput, receiptProblem, receiptRoute, type ReceiptForm } from './receipt-form';
import { payoutFields, refundInput, refundKey, refundProblem, refundRoute, startingDetails, type RefundForm } from './refund-form';
import { applications, canApply, chosenCents, fillOldest, groupApplications, needsComment, postedMessage } from './receipt-detail';
import { listArgs } from './finance-list-filters';
import { RECEIPT_STATUS, statusChoices, statusInfo } from './finance-statuses';

const traits = methodTraits({ currency: 'USD', requiresReference: '1', requiresEvidence: '', requiresCounterparty: '1', min: '10', max: '' });
const form: ReceiptForm = {
  customerId: 'c1', methodId: 'm1', traits, amount: ' 50.00 ', date: '2026-10-14', reference: ' ABC ', payer: '', cheque: { chequeNo: '1', bank: 'B', drawer: 'D', chequeDate: '' },
  narration: '  ', rate: ' 130 ', deposit: false, allocate: 'oldest_first',
};

describe('receipt form', () => {
  it('reads the traits the server sent', () => {
    expect(traits).toEqual({ currency: 'USD', requiresReference: true, requiresEvidence: false, requiresCounterparty: true, min: '10', max: '' });
    expect(methodTraits(undefined)).toBeNull();
    expect(isForeign(traits, 'KES')).toBe(true);
    expect(isForeign(traits, 'USD')).toBe(false);
    expect(isForeign(null, 'KES')).toBe(false);
    expect(amountHint(traits)).toBe('Allowed: 10 to no limit');
    expect(amountHint(methodTraits({ min: '', max: '' }))).toBeUndefined();
  });

  it('says what is missing first', () => {
    expect(receiptProblem({ ...form, customerId: null })).toBe('Choose the customer who paid.');
    expect(receiptProblem({ ...form, methodId: null })).toBe('Choose how the customer paid.');
    expect(receiptProblem(form)).toBeNull();
  });

  it('builds the input, trimming text, leaving blanks null and the rate only for a foreign method', () => {
    const input = receiptInput(form, 'key', 'KES');
    expect(input).toMatchObject({ customerId: 'c1', paymentMethodId: 'm1', amount: '50.00', currency: 'USD', rate: '130', externalReference: 'ABC', payerName: null, narration: null, idempotencyKey: 'key', isDeposit: false });
    expect(input.counterparty).toEqual(form.cheque);
    expect(receiptInput({ ...form, traits: methodTraits({ currency: 'KES' }) }, 'k', 'KES')).toMatchObject({ rate: undefined, counterparty: {} });
  });

  it('posts with the chosen allocation, but never applies an advance deposit', () => {
    expect(postOptions(form, false)).toBeUndefined();
    expect(postOptions(form, true)).toEqual({ allocate: 'oldest_first' });
    expect(postOptions({ ...form, deposit: true }, true)).toEqual({ allocate: 'none' });
  });

  it('routes to the receipt, with the reason when posting failed', () => {
    expect(receiptRoute('r1', null)).toBe('/admin/finance/receipts/r1');
    expect(receiptRoute('r1', 'no period')).toBe('/admin/finance/receipts/r1?posting_failed=no%20period');
    expect(customerStanding({ accountType: 'credit', balance: '5' }, (v) => `KES ${v}`)).toBe('Credit customer · owes KES 5');
    expect(customerStanding({ accountType: 'cash' }, String)).toBe('Cash customer');
  });
});

describe('refund form', () => {
  const refund: RefundForm = { customerId: 'c1', sourceKind: 'wallet', sourceId: 'w1', amount: ' 20 ', methodId: 'm1', details: { phone: '0712' }, reasonCode: 'overpaid', reasonText: ' ', };
  it('asks for the right payout details by kind', () => {
    expect(payoutFields('mobile_money').map((f) => f.key)).toEqual(['phone']);
    expect(payoutFields('bank_transfer').map((f) => f.key)).toEqual(['bankName', 'accountNumber', 'accountName']);
    expect(payoutFields('card')).toEqual([]);
    expect(payoutFields(undefined)).toEqual([]);
    expect(startingDetails('0712')).toEqual({ phone: '0712' });
    expect(startingDetails(null)).toEqual({});
  });

  it('says what is missing first and builds the input with a stable key', () => {
    expect(refundProblem({ ...refund, customerId: null })).toBe('Choose the customer.');
    expect(refundProblem({ ...refund, sourceId: null })).toBe('Choose what the refund is taken from.');
    expect(refundProblem({ ...refund, methodId: null })).toBe('Choose how it will be paid.');
    expect(refundProblem({ ...refund, reasonCode: null })).toBe('Choose a reason.');
    expect(refundProblem(refund)).toBeNull();
    expect(refundInput(refund, 'n')).toMatchObject({ amount: '20', reasonText: undefined, idempotencyKey: refundKey(refund, 'n') });
    expect(refundKey(refund, 'n')).toBe(refundKey({ ...refund, amount: '20' }, 'n'));
    expect(refundRoute('r', null)).toBe('/admin/finance/refunds/r');
    expect(refundRoute('r', 'x y')).toBe('/admin/finance/refunds/r?note=x%20y');
  });
});

describe('receipt page arithmetic', () => {
  const open = [{ entryId: 'a', remaining: '60.00' }, { entryId: 'b', remaining: '50.00' }, { entryId: 'c', remaining: '10.00' }];
  it('fills oldest first and stops when the money is used up', () => {
    expect(fillOldest(open, '100.00')).toEqual({ a: '60.00', b: '40.00' });
    expect(fillOldest(open, '0')).toEqual({});
    expect(fillOldest(open, '500')).toEqual({ a: '60.00', b: '50.00', c: '10.00' });
  });

  it('totals what was typed in cents and only allows applying up to the unapplied amount', () => {
    expect(chosenCents({ a: '10.10', b: 'x', c: '-5', d: '0.20' })).toBe(1030);
    expect(canApply({ a: '10' }, '10.00')).toBe(true);
    expect(canApply({ a: '10.01' }, '10.00')).toBe(false);
    expect(canApply({}, '10')).toBe(false);
    expect(applications({ a: '5', b: '', c: '0' })).toEqual([{ entryId: 'a', amount: '5' }]);
  });

  it('groups the rows of one application and totals them', () => {
    const groups = groupApplications([
      { applicationId: 'x', at: 't', undone: false, invoiceNo: 'INV-1', amount: '10.10' },
      { applicationId: 'x', at: 't', undone: false, invoiceNo: 'INV-2', amount: '0.20' },
      { applicationId: 'y', at: 't', undone: true, invoiceNo: 'INV-3', amount: '1' },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ applicationId: 'x', totalCents: 1030 });
    expect(groups[0]?.rows).toHaveLength(2);
    expect(groups[1]?.undone).toBe(true);
  });

  it('words the result of posting and knows which reasons need a comment', () => {
    expect(postedMessage('0', true, String)).toBe('Posted.');
    expect(postedMessage('25.00', false, (v) => `KES ${v}`)).toBe('Posted and applied KES 25.00 to invoices (general ledger posting is not switched on yet).');
    expect(needsComment({ requiresComment: '1' })).toBe(true);
    expect(needsComment({})).toBe(false);
    expect(needsComment(undefined)).toBe(false);
  });

  it('labels states, falling back to the state itself', () => {
    expect(statusInfo(RECEIPT_STATUS, 'posted')).toEqual({ label: 'Posted', tone: 'green' });
    expect(statusInfo(RECEIPT_STATUS, 'odd')).toEqual({ label: 'odd', tone: 'gray' });
    expect(statusInfo(RECEIPT_STATUS, null).tone).toBe('gray');
    expect(statusChoices(RECEIPT_STATUS).map((c) => c.id)).toEqual(['draft', 'posted', 'reversed', 'cancelled']);
  });
});


describe('list filters', () => {
  it('sends only the filters that were set', () => {
    expect(listArgs(null, '  ')).toEqual({});
    expect(listArgs('posted', ' rc ', 'cursor')).toEqual({ status: 'posted', q: 'rc', before: 'cursor' });
    expect(listArgs(null, '', null)).toEqual({});
  });
});

import { has, historyDetail, historyHeadline, historyReason, plain, recordValue, submitMessage } from './finance-history';

describe('history wording', () => {
  it('words a history entry', () => {
    expect(historyHeadline({ event: 'refund_approved', from: 'pending_approval', to: 'approved' })).toBe('refund approved → approved');
    expect(historyHeadline({ event: 'viewed', from: 'x', to: 'x' })).toBe('viewed');
    expect(historyHeadline({ event: 'created', from: null, to: null })).toBe('created');
    expect(historyDetail({ at: 't', by: 'Ann', surface: 'finance/refunds', permission: null }, (v) => `at ${v}`)).toBe('Ann · at t · from finance/refunds');
    expect(historyReason({ reasonCode: 'wrong_item', reasonText: 'sent twice' })).toBe('wrong item: sent twice');
    expect(historyReason({ reasonCode: 'wrong_item', reasonText: null })).toBe('wrong item');
    expect(historyReason({ reasonCode: null, reasonText: 'x' })).toBe('');
  });

  it('has small helpers for loose values', () => {
    expect(has('')).toBe(false);
    expect(has(null)).toBe(false);
    expect(has('a')).toBe(true);
    expect(recordValue({ a: '1', b: '' }, 'a')).toBe('1');
    expect(recordValue({ a: '1', b: '' }, 'b')).toBe('—');
    expect(recordValue({}, 'c')).toBe('—');
    expect(plain('a_b_c')).toBe('a b c');
    expect(submitMessage('approved')).toContain('set aside');
    expect(submitMessage('pending_approval')).toBe('Sent for approval.');
  });
});

import { lastDays } from './report-window';

describe('report window', () => {
  it('gives the last days up to now', () => {
    expect(lastDays(new Date('2026-10-31T23:00:00Z'), 30)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
  });
});
