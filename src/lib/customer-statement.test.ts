import { describe, expect, it } from 'vitest';
import {
  buildCustomerStatementCsv,
  customerStatementFileName,
  ledgerAppliedTotals,
  statementDocumentNumber,
  statementDownloadDocument,
  statementRowBalances,
  statementSpan,
  type StatementDownload,
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

describe('statement downloads', () => {
  const statement: StatementDownload = {
    customerName: 'E2E, Customer',
    customerNumber: 'CUS-001',
    from: '2026-09-01',
    to: '2026-09-30',
    openingBalance: '100.00',
    totalDebit: '250.00',
    totalCredit: '50.00',
    closingBalance: '300.00',
    lines: [
      {
        date: '2026-09-02',
        document: statementDownloadDocument('invoice', 'SO-42', 'INV-17'),
        description: '=SUM(A1:A2)',
        dueDate: '2026-10-02',
        debit: '250.00',
        credit: '—',
        balance: '350.00',
      },
      {
        date: '2026-09-03',
        document: 'Receipt RCP-9',
        description: 'Payment',
        dueDate: null,
        debit: '0.00',
        credit: '100.00',
        balance: '-50.00',
      },
    ],
  };

  it('names the file from the customer number and chosen range', () => {
    expect(customerStatementFileName('CUS/001', 'pdf', '2026-09-01', '2026-09-30')).toBe(
      'customer-statement-CUS-001-2026-09-01-2026-09-30.pdf',
    );
    expect(customerStatementFileName('CUS-001', 'csv', '', '')).toBe(
      'customer-statement-CUS-001.csv',
    );
  });

  it('writes a guarded CSV with the tax invoice number and period totals', () => {
    const csv = buildCustomerStatementCsv(statement);
    expect(csv.startsWith('\ufeff')).toBe(true);
    expect(csv).toContain('Customer number,CUS-001\r\n');
    expect(csv).toContain('Period,2026-09-01 to 2026-09-30\r\n');
    expect(csv).toContain('Tax invoice INV-17');
    expect(csv).toContain("'=SUM(A1:A2)");
    expect(csv).toContain(',-50.00\r\n');
    expect(csv).not.toContain(",'-50.00");
    expect(csv).toContain('Date,Document,Description,Due,Debit,Credit,Balance');
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
