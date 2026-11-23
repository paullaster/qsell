import { guardFormula, toCsv, UTF8_BOM } from './csv';

/**
 * The words of a statement of account, used by the screen, the PDF and the CSV so one document reads the same everywhere. The layout
 * follows the usual statement of a trade receivable: balance brought forward, debits (invoices and other charges), credits (payments
 * and credit notes), closing balance, with the open invoices aged by how far past due they are.
 */
export const STATEMENT_WORDS = {
  title: 'Statement of Account',
  accountHolder: 'Account holder',
  statementDetails: 'Statement details',
  accountNumber: 'Account no.',
  statementDate: 'Statement date',
  period: 'Statement period',
  currency: 'Currency',
  paymentTerms: 'Payment terms',
  creditLimit: 'Approved credit limit',
  summary: 'Account summary',
  broughtForward: 'Balance brought forward',
  debits: 'Invoices and other debits',
  credits: 'Payments and credits',
  closing: 'Closing balance',
  closingDue: 'Closing balance due',
  aged: 'Aged analysis of open invoices',
  transactions: 'Transactions',
  empty: 'There are no transactions in this period.',
} as const;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** 2026-09-02 as "02 Sep 2026"; anything that is not a calendar date is returned as it came. */
export function statementDate(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  const month = m === null ? undefined : MONTHS[Number(m[2]) - 1];
  return m === null || month === undefined ? (iso ?? '') : `${m[3] ?? ''} ${month} ${m[1] ?? ''}`;
}

/** The period a statement covers, in words. */
export function statementPeriodText(from: string, to: string): string {
  if (from === '' && to === '') return 'All transactions to date';
  if (from === '') return `All transactions up to ${statementDate(to)}`;
  if (to === '') return `${statementDate(from)} to date`;
  return `${statementDate(from)} to ${statementDate(to)}`;
}

/** An ageing bucket as a lender reads it: what is not yet due is current, the rest is past due. */
export function statementAgeLabel(label: string): string {
  return label === 'Not yet due' ? 'Current (not yet due)' : `${label} past due`;
}

/** What the debit and credit columns mean, printed under the statement. */
export const STATEMENT_NOTES: readonly string[] = [
  'Debits are invoices and other charges that increase the amount owed. Credits are payments received and credit notes that reduce it.',
  'A balance shown with a minus sign is a credit balance in the customer\'s favour.',
  'Open invoices are aged from their due date as at the statement date.',
  'This statement is produced by the accounting system from the posted customer ledger.',
];

/** Opening balance plus debits less credits must equal the closing balance; a statement that does not add up is not issued. */
export function statementAddsUp(opening: string, debit: string, credit: string, closing: string): boolean {
  const cents = (value: string): number => Math.round(Number(value) * 100);
  return cents(opening) + cents(debit) - cents(credit) === cents(closing);
}

export interface StatementRowBalance {
  debitCents: number;
  creditCents: number;
  runningCents: number;
}

export function statementRowBalances(
  amountCents: number[],
  openingCents: number,
): StatementRowBalance[] {
  let runningCents = openingCents;
  return amountCents.map((amountCents) => {
    runningCents += amountCents;
    return {
      debitCents: amountCents > 0 ? amountCents : 0,
      creditCents: amountCents < 0 ? -amountCents : 0,
      runningCents,
    };
  });
}

export function statementSpan(
  rows: readonly { date: string | null }[],
  fallback: { from: string; to: string },
): { from: string; to: string } {
  const dates = rows
    .map((row) => row.date)
    .filter((date): date is string => date !== null && date.trim() !== '')
    .sort();
  if (dates.length === 0) return { from: fallback.from, to: fallback.to };
  return { from: dates[0] ?? fallback.from, to: dates[dates.length - 1] ?? fallback.to };
}

export function statementDocumentNumber(
  type: string,
  documentNo: string,
  invoiceNo: string | null,
): string {
  if (type !== 'invoice') return documentNo;
  return invoiceNo === null || invoiceNo.trim() === '' ? '' : invoiceNo;
}

export interface StatementDownloadLine {
  date: string | null;
  document: string;
  description: string;
  dueDate: string | null;
  debit: string;
  credit: string;
  balance: string;
}

export interface StatementAgeBucket {
  label: string;
  amount: string;
  count: number;
}

export interface StatementDownload {
  customerName: string;
  customerNumber: string;
  /** The customer's tax PIN and postal address, as recorded on the card; empty when not recorded. */
  customerKraPin: string;
  customerAddress: readonly string[];
  /** "Credit (on account)" or "Cash", with the days to pay for a credit customer. */
  paymentTerms: string;
  /** The approved credit limit, or empty for a cash customer. */
  creditLimit: string;
  /** The currency of the amounts, as 3 letters; empty when the account has no postings. */
  currency: string;
  /** The day the statement was produced, as YYYY-MM-DD. */
  statementDate: string;
  /** Open invoices aged as at the statement date. */
  ageing: readonly StatementAgeBucket[];
  from: string;
  to: string;
  openingBalance: string;
  totalDebit: string;
  totalCredit: string;
  closingBalance: string;
  lines: readonly StatementDownloadLine[];
}

export function statementDownloadDocument(
  type: string,
  documentNo: string,
  invoiceNo: string | null,
): string {
  const number = statementDocumentNumber(type, documentNo, invoiceNo);
  if (type !== 'invoice') return number === '' ? documentNo : number;
  return number === '' ? 'Tax invoice number not recorded' : `Tax invoice ${number}`;
}

export function customerStatementFileName(
  customerNumber: string,
  format: 'pdf' | 'csv',
  from: string,
  to: string,
): string {
  const safeOr = (value: string, fallback: string): string => {
    const safe = value.replace(/[^A-Za-z0-9._-]+/g, '-');
    return safe === '' ? fallback : safe;
  };
  const range = from === '' && to === '' ? '' : `-${safeOr(from, 'from')}-${safeOr(to, 'to')}`;
  return `customer-statement-${safeOr(customerNumber, 'customer')}${range}.${format}`;
}

export function buildCustomerStatementCsv(statement: StatementDownload): string {
  const text = (value: string): string => guardFormula(value);
  const W = STATEMENT_WORDS;
  const rows: (readonly string[])[] = [
    [W.title],
    [W.accountHolder, text(statement.customerName)],
    [W.accountNumber, text(statement.customerNumber)],
    ...(statement.customerKraPin === '' ? [] : [['KRA PIN', text(statement.customerKraPin)]]),
    [W.statementDate, statementDate(statement.statementDate)],
    [W.period, statementPeriodText(statement.from, statement.to)],
    ...(statement.currency === '' ? [] : [[W.currency, statement.currency]]),
    [W.paymentTerms, text(statement.paymentTerms)],
    ...(statement.creditLimit === '' ? [] : [[W.creditLimit, statement.creditLimit]]),
    [],
    [W.summary],
    [W.broughtForward, statement.openingBalance],
    [W.debits, statement.totalDebit],
    [W.credits, statement.totalCredit],
    [W.closingDue, statement.closingBalance],
    [],
    [W.aged, ''],
    ...statement.ageing.map((b) => [statementAgeLabel(b.label), b.amount]),
    [],
    [W.transactions],
    ['Date', 'Reference', 'Details', 'Due date', 'Debit', 'Credit', 'Balance'],
    ...statement.lines.map((line) => [
      statementDate(line.date),
      text(line.document),
      text(line.description),
      statementDate(line.dueDate),
      line.debit,
      line.credit,
      line.balance,
    ]),
  ];
  return UTF8_BOM + toCsv(rows);
}

export function ledgerAppliedTotals(
  history: readonly { appliedToEntryId: string | null; amount: string }[],
  documentType: string,
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of history) {
    if (row.appliedToEntryId === null) continue;
    const cents = Math.round(Number(row.amount) * 100);
    const effect = documentType === 'invoice' ? -cents : cents;
    totals.set(row.appliedToEntryId, (totals.get(row.appliedToEntryId) ?? 0) + effect);
  }
  return totals;
}
