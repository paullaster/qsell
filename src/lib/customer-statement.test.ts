import { describe, expect, it } from 'vitest';
import {
  ledgerAppliedTotals,
  statementDocumentNumber,
  statementRowBalances,
  statementSpan,
} from './customer-statement';

describe('customer statement balances', () => {
  it('splits signed ledger amounts into debit and credit and carries the running balance', () => {
    expect(statementRowBalances([10000, -2500, 500], 2000)).toEqual([
      { debitCents: 10000, creditCents: 0, runningCents: 12000 },
      { debitCents: 0, creditCents: 2500, runningCents: 9500 },
      { debitCents: 500, creditCents: 0, runningCents: 10000 },
    ]);
  });

  it('keeps zero and negative balances without inventing debit or credit', () => {
    expect(statementRowBalances([0, -4000], 4000)).toEqual([
      { debitCents: 0, creditCents: 0, runningCents: 4000 },
      { debitCents: 0, creditCents: 4000, runningCents: 0 },
    ]);
  });
});

describe('customer statement date span', () => {
  it('uses the earliest and latest dates in the loaded rows', () => {
    expect(
      statementSpan(
        [{ date: '2026-10-02' }, { date: '2026-09-01' }, { date: null }, { date: '2026-09-10' }],
        { from: '', to: '' },
      ),
    ).toEqual({ from: '2026-09-01', to: '2026-10-02' });
  });

  it('keeps the requested range when no dated rows are loaded', () => {
    expect(statementSpan([{ date: null }], { from: '2026-09-01', to: '2026-09-30' })).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
    });
  });
});

describe('statementDocumentNumber', () => {
  it('uses the invoice number instead of the sales order number on invoice rows', () => {
    expect(statementDocumentNumber('invoice', 'SO-42', 'INV-17')).toBe('INV-17');
    expect(statementDocumentNumber('invoice', 'SO-42', null)).toBe('');
    expect(statementDocumentNumber('payment', 'RCP-9', null)).toBe('RCP-9');
  });
});

describe('ledgerAppliedTotals', () => {
  it('turns an invoice-side application and its reversal into the amount applied', () => {
    const history = [
      { appliedToEntryId: 'pay-1', amount: '-40.00' },
      { appliedToEntryId: 'pay-1', amount: '10.00' },
      { appliedToEntryId: null, amount: '100.00' },
    ];
    expect([...ledgerAppliedTotals(history, 'invoice')]).toEqual([['pay-1', 3000]]);
  });

  it('keeps the payment-side amount positive when money is used and reversed', () => {
    const history = [
      { appliedToEntryId: 'inv-1', amount: '40.00' },
      { appliedToEntryId: 'inv-1', amount: '-10.00' },
    ];
    expect([...ledgerAppliedTotals(history, 'payment')]).toEqual([['inv-1', 3000]]);
  });
});
