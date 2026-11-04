'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { receiptApplyOptionsAction } from '@/server/domains/finance/receivables/actions';
import { chosenCents, fillOldest, fromCents, toCents, type OpenInvoiceView } from '@/lib/receipt-detail';
import { buttonClass, fieldClass, money, attempt } from './ui';

/**
 * Lets a person say exactly which of a customer's unpaid invoices a payment goes to, and how much of it to each. Each invoice shows
 * the number the customer was given, the order behind it, when it is due, what is still owed and what was sold. The amounts typed are
 * only a request: the server checks them again against the locked invoices.
 */
export function InvoiceAllocator({
  customerId,
  available,
  currency,
  amounts,
  onAmounts,
  onLoaded,
}: {
  customerId: string;
  /** What the payment can cover, as a decimal string. */
  available: string;
  currency: string;
  amounts: Record<string, string>;
  onAmounts: (next: Record<string, string>) => void;
  onLoaded?: (invoices: OpenInvoiceView[]) => void;
}) {
  const uid = useId();
  const [invoices, setInvoices] = useState<OpenInvoiceView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(amounts);
  useEffect(() => {
    latest.current = amounts;
  });

  useEffect(() => {
    const alive = { current: true };
    void (async () => {
      setInvoices(null);
      setError(null);
      const res = await attempt(receiptApplyOptionsAction(customerId));
      if (!alive.current) return;
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setInvoices(res.data);
      // Amounts typed for another customer's invoices must not travel with this one.
      const known = new Set(res.data.map((i) => i.entryId));
      const kept = Object.entries(latest.current).filter(([id]) => known.has(id));
      if (kept.length !== Object.keys(latest.current).length) onAmounts(Object.fromEntries(kept));
      onLoaded?.(res.data);
    })();
    return () => {
      alive.current = false;
    };
    // The list belongs to the customer; a new callback identity must not reload it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  const chosen = chosenCents(amounts);
  const room = toCents(available);
  const over = chosen > room;

  if (error !== null) return <p role="alert" className="text-sm text-red-700">{error}</p>;
  if (invoices === null) return <p className="text-sm text-fg-muted" aria-live="polite">Loading the customer&apos;s unpaid invoices…</p>;
  if (invoices.length === 0) return <p className="text-sm text-fg-muted">This customer has no unpaid invoices.</p>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={`text-sm ${over ? 'text-red-700' : 'text-fg'}`} aria-live="polite">
          Applying {currency} {money(fromCents(chosen))} of {money(available)}.
        </p>
        <div className="flex gap-2">
          <button type="button" className={buttonClass} onClick={() => onAmounts(fillOldest(invoices, available))}>Fill oldest first</button>
          <button type="button" className={buttonClass} onClick={() => onAmounts({})} disabled={chosen === 0}>Clear</button>
        </div>
      </div>
      <ul className="space-y-2" aria-label="Unpaid invoices">
        {invoices.map((inv) => {
          const inputId = `${uid}-${inv.entryId}`;
          return (
            <li key={inv.entryId} className="rounded-xl border border-line bg-surface-raised p-3 md:grid md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-start md:gap-4">
              <div className="min-w-0">
                <p className="text-sm font-bold text-fg-strong break-words">{inv.documentNo}</p>
                {inv.order !== null ? <p className="text-xs text-fg-muted">{inv.order}</p> : null}
                {inv.lines.length > 0 ? (
                  <details className="mt-1 text-xs text-fg">
                    <summary className="min-h-10 cursor-pointer py-2 text-indigo-600">{inv.lines.length + inv.moreLines} {inv.lines.length + inv.moreLines === 1 ? 'item' : 'items'}</summary>
                    <ul className="space-y-0.5">
                      {inv.lines.map((l, i) => (
                        <li key={`${l.text}-${String(i)}`} className="flex justify-between gap-3"><span className="min-w-0 break-words">{l.text}</span><span className="tabular-nums">{money(l.total)}</span></li>
                      ))}
                      {inv.moreLines > 0 ? <li className="text-fg-muted">and {inv.moreLines} more</li> : null}
                    </ul>
                  </details>
                ) : null}
              </div>
              <div className="mt-2 text-xs text-fg md:mt-0 md:text-right">
                <p>Due {inv.dueDate ?? '—'}</p>
                <p>Still owed <strong className="tabular-nums">{money(inv.remaining)}</strong></p>
              </div>
              <div className="mt-2 md:mt-0">
                <label htmlFor={inputId} className="sr-only">Amount to apply to {inv.documentNo}</label>
                <input
                  id={inputId}
                  value={amounts[inv.entryId] ?? ''}
                  onChange={(e) => onAmounts({ ...amounts, [inv.entryId]: e.target.value })}
                  className={`${fieldClass} w-full text-right tabular-nums md:w-32`}
                  inputMode="decimal"
                  placeholder="0.00"
                  autoComplete="off"
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
