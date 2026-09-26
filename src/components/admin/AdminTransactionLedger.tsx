import type { TransactionLedgerLine } from '@/server/domains/transactions/ledger-service';

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
          <table className="w-full min-w-[760px] border-collapse text-left text-sm text-fg">
            <thead className="sticky top-0 z-10 bg-surface text-xs tracking-wide text-fg-subtle uppercase shadow-[0_1px_0_0_rgb(39_39_42)]">
              <tr>
                <th className="px-4 py-3 font-medium">Posted</th>
                <th className="px-4 py-3 font-medium">Document</th>
                <th className="px-4 py-3 font-medium">Number</th>
                <th className="px-4 py-3 font-medium">Reference</th>
                <th className="px-4 py-3 font-medium">Customer</th>
                <th className="px-4 py-3 font-medium">Description</th>
                <th className="px-4 py-3 text-right font-medium">Debit</th>
                <th className="px-4 py-3 text-right font-medium">Credit</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.id} className="border-t border-line">
                  <td className="px-4 py-3 whitespace-nowrap text-fg-muted">
                    {postedFormat.format(line.postedAt)}
                  </td>
                  <td className="px-4 py-3">{documentLabel(line.documentType)}</td>
                  <td className="px-4 py-3 font-medium text-fg-strong">{line.documentNo}</td>
                  <td className="px-4 py-3 font-mono text-xs text-fg-strong">
                    {line.direction === 'credit' ? line.transactionReference || '—' : '—'}
                  </td>
                  <td className="px-4 py-3">
                    {line.customerNumber ? (
                      <span>
                        <span className="text-fg-subtle">{line.customerNumber}</span>
                        {line.customerName ? ` ${line.customerName}` : ''}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-4 py-3 text-fg-muted">{line.description || '—'}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap tabular-nums">
                    {line.direction === 'debit' ? money(line.amount) : '—'}
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap tabular-nums">
                    {line.direction === 'credit' ? money(line.amount) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="sticky bottom-0 z-10 bg-surface shadow-[0_-1px_0_0_rgb(63_63_70)]">
              {totalRows.map(([currency, total]) => (
                <tr key={currency} className="border-t border-line-strong">
                  <td
                    colSpan={6}
                    className="px-4 py-3 text-xs font-semibold tracking-wide text-fg-muted uppercase"
                  >
                    Total · {currency}
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-semibold whitespace-nowrap text-amber-800 tabular-nums">
                    {money(total.debit)}
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-semibold whitespace-nowrap text-emerald-800 tabular-nums">
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
