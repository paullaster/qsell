import { guardFormula, toCsv, UTF8_BOM } from './csv';

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

export interface StatementDownload {
  customerName: string;
  customerNumber: string;
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
  const rows: (readonly string[])[] = [
    ['Customer statement'],
    ['Customer', text(statement.customerName)],
    ['Customer number', text(statement.customerNumber)],
    [
      'Period',
      statement.from === '' && statement.to === ''
        ? 'All dates'
        : `${statement.from} to ${statement.to}`,
    ],
    ['Opening balance', statement.openingBalance],
    ['Debits this period', statement.totalDebit],
    ['Credits this period', statement.totalCredit],
    ['Closing balance', statement.closingBalance],
    [],
    ['Date', 'Document', 'Description', 'Due', 'Debit', 'Credit', 'Balance'],
    ...statement.lines.map((line) => [
      line.date ?? '',
      text(line.document),
      text(line.description),
      line.dueDate ?? '',
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
