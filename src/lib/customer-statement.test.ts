import { describe, expect, it } from 'vitest';
import {
  buildCustomerStatementCsv,
  customerStatementFileName,
  ledgerAppliedTotals,
  statementAddsUp,
  statementAgeLabel,
  statementDate,
  statementDocumentNumber,
  statementDownloadDocument,
  statementPeriodText,
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
    customerKraPin: 'A123456789Z',
    customerAddress: ['1 Market Road', 'Nairobi, Nairobi, 00100', 'Kenya'],
    paymentTerms: 'Credit (on account), 30 days',
    creditLimit: '5000.00',
    currency: 'KES',
    statementDate: '2026-09-30',
    ageing: [
      { label: 'Not yet due', amount: '100.00', count: 1 },
      { label: '1–30 days', amount: '200.00', count: 2 },
    ],
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
    expect(csv).toContain('Statement of Account\r\n');
    expect(csv).toContain('Account no.,CUS-001\r\n');
    expect(csv).toContain('Statement period,01 Sep 2026 to 30 Sep 2026\r\n');
    expect(csv).toContain('Currency,KES\r\n');
    expect(csv).toContain('Balance brought forward,100.00\r\n');
    expect(csv).toContain('Closing balance due,300.00\r\n');
    expect(csv).toContain('Current (not yet due),100.00\r\n');
    expect(csv).toContain('1–30 days past due,200.00\r\n');
    expect(csv).toContain('Tax invoice INV-17');
    expect(csv).toContain("'=SUM(A1:A2)");
    expect(csv).toContain(',-50.00\r\n');
    expect(csv).not.toContain(",'-50.00");
    expect(csv).toContain('Date,Reference,Details,Due date,Debit,Credit,Balance');
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

describe('statement wording and checks', () => {
  it('writes dates and periods the way a statement does', () => {
    expect(statementDate('2026-09-02')).toBe('02 Sep 2026');
    expect(statementDate(null)).toBe('');
    expect(statementPeriodText('', '')).toBe('All transactions to date');
    expect(statementPeriodText('2026-09-01', '')).toBe('01 Sep 2026 to date');
    expect(statementPeriodText('', '2026-09-30')).toBe('All transactions up to 30 Sep 2026');
  });

  it('calls what is not due current and the rest past due', () => {
    expect(statementAgeLabel('Not yet due')).toBe('Current (not yet due)');
    expect(statementAgeLabel('Over 90 days')).toBe('Over 90 days past due');
  });

  it('only accepts a statement whose opening balance plus debits less credits is its closing balance', () => {
    expect(statementAddsUp('100.00', '250.00', '50.00', '300.00')).toBe(true);
    expect(statementAddsUp('100.10', '0.20', '0.00', '100.30')).toBe(true);
    expect(statementAddsUp('100.00', '250.00', '50.00', '299.99')).toBe(false);
  });
});
