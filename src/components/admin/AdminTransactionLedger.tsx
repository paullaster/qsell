import type { TransactionLedgerLine } from '@/server/domains/transactions/ledger-service';
import { has } from '@/lib/values';

const amountFormat = new Intl.NumberFormat('en-KE', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const postedFormat = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function money(amount: number | string): string {
  const value = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(value)) return String(amount);
  return amountFormat.format(value);
}

function documentLabel(documentType: string): string {
  if (documentType === 'invoice') return 'Invoice';
  if (documentType === 'payment') return 'Payment';
  return documentType;
}

/** The payment's own reference on a credit; a debit has none. */
const creditReference = (line: TransactionLedgerLine): string => (line.direction === 'credit' && has(line.transactionReference) ? line.transactionReference : '—');

export function AdminTransactionLedger({ lines }: { lines: TransactionLedgerLine[] }) {
  const totals = new Map<string, { debit: number; credit: number }>();
  for (const line of lines) {
    const bucket = totals.get(line.currency) ?? { debit: 0, credit: 0 };
    const amount = Number(line.amount);
    if (line.direction === 'debit') bucket.debit += amount;
    if (line.direction === 'credit') bucket.credit += amount;
    totals.set(line.currency, bucket);
  }
  const totalRows = [...totals.entries()];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold text-fg-strong">Transactions Ledger</h2>
        <p className="mt-1 max-w-2xl text-sm text-fg-muted">
          Posted sales (debit) and payments (credit). Only the transaction ledger service writes
          these rows.
        </p>
      </div>

      {lines.length === 0 ? (
        <p className="rounded-xl border border-line bg-surface-sunken/50 px-4 py-8 text-sm text-fg-subtle">
          No ledger entries yet. They appear when an invoice or a customer payment is posted.
        </p>
      ) : (
        <div className="max-h-[min(70vh,56rem)] overflow-auto rounded-xl border border-line">
          <table role="table" className="block md:table w-full border-collapse text-left text-sm text-fg">
            <thead role="rowgroup" className="hidden md:table-header-group sticky top-0 z-10 bg-surface text-xs tracking-wide text-fg-subtle uppercase shadow-[0_1px_0_0_rgb(39_39_42)]">
              <tr role="row" className="block md:table-row">
                <th role="columnheader" className="px-4 py-3 font-medium">Posted</th>
                <th role="columnheader" className="px-4 py-3 font-medium">Document</th>
                <th role="columnheader" className="px-4 py-3 font-medium">Number</th>
                <th role="columnheader" className="px-4 py-3 font-medium">Reference</th>
                <th role="columnheader" className="px-4 py-3 font-medium">Customer</th>
                <th role="columnheader" className="px-4 py-3 font-medium">Description</th>
                <th role="columnheader" className="px-4 py-3 text-right font-medium">Debit</th>
                <th role="columnheader" className="px-4 py-3 text-right font-medium">Credit</th>
              </tr>
            </thead>
            <tbody role="rowgroup" className="block md:table-row-group">
              {lines.map((line) => (
                <tr role="row" key={line.id} className="block md:table-row border-t border-line">
                  <td role="cell" className="before:mr-2 before:text-xs before:font-normal before:text-fg-muted before:content-[attr(data-label)] md:before:hidden block md:table-cell px-4 py-3 whitespace-nowrap text-fg-muted" data-label="Posted">
                    {postedFormat.format(line.postedAt)}
                  </td>
                  <td role="cell" className="before:mr-2 before:text-xs before:font-normal before:text-fg-muted before:content-[attr(data-label)] md:before:hidden block md:table-cell px-4 py-3" data-label="Document">{documentLabel(line.documentType)}</td>
                  <td role="cell" className="before:mr-2 before:text-xs before:font-normal before:text-fg-muted before:content-[attr(data-label)] md:before:hidden block md:table-cell px-4 py-3 font-medium text-fg-strong" data-label="Number">{line.documentNo}</td>
                  <td role="cell" className="before:mr-2 before:text-xs before:font-normal before:text-fg-muted before:content-[attr(data-label)] md:before:hidden block md:table-cell px-4 py-3 font-mono text-xs text-fg-strong" data-label="Reference">
                    {creditReference(line)}
                  </td>
                  <td role="cell" className="before:mr-2 before:text-xs before:font-normal before:text-fg-muted before:content-[attr(data-label)] md:before:hidden block md:table-cell px-4 py-3" data-label="Customer">
                    {has(line.customerNumber) ? (
                      <span>
                        <span className="text-fg-subtle">{line.customerNumber}</span>
                        {has(line.customerName) ? ` ${line.customerName}` : ''}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td role="cell" className="before:mr-2 before:text-xs before:font-normal before:text-fg-muted before:content-[attr(data-label)] md:before:hidden block md:table-cell px-4 py-3 text-fg-muted" data-label="Description">{has(line.description) ? line.description : '—'}</td>
                  <td role="cell" className="before:mr-2 before:text-xs before:font-normal before:text-fg-muted before:content-[attr(data-label)] md:before:hidden block md:table-cell px-4 py-3 md:text-right whitespace-nowrap tabular-nums" data-label="Debit">
                    {line.direction === 'debit' ? money(line.amount) : '—'}
                  </td>
                  <td role="cell" className="before:mr-2 before:text-xs before:font-normal before:text-fg-muted before:content-[attr(data-label)] md:before:hidden block md:table-cell px-4 py-3 md:text-right whitespace-nowrap tabular-nums" data-label="Credit">
                    {line.direction === 'credit' ? money(line.amount) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot role="rowgroup" className="block md:table-footer-group sticky bottom-0 z-10 bg-surface shadow-[0_-1px_0_0_rgb(63_63_70)]">
              {totalRows.map(([currency, total]) => (
                <tr role="row" key={currency} className="block md:table-row border-t border-line-strong">
                  <td role="cell"
                    colSpan={6}
                    className="block md:table-cell px-4 py-3 text-xs font-semibold tracking-wide text-fg-muted uppercase"
                  >
                    Total · {currency}
                  </td>
                  <td role="cell" className="block md:table-cell px-4 py-3 md:text-right text-sm font-semibold whitespace-nowrap text-amber-800 tabular-nums">
                    {money(total.debit)}
                  </td>
                  <td role="cell" className="block md:table-cell px-4 py-3 md:text-right text-sm font-semibold whitespace-nowrap text-emerald-800 tabular-nums">
                    {money(total.credit)}
                  </td>
                </tr>
              ))}
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
