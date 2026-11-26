'use client';

import { useWhen } from '@/components/business-time';
import type { DayScreen } from '@/server/domains/van-sales/actions';
import { Chip, cardClass } from '@/components/ui/screen-kit';
import { kes } from '@/lib/till/tile-style';

/** What the day has sold so far and how it was paid. Shown once something has been sold. */
export function SalesPanel({ screen }: { screen: DayScreen }) {
  const when = useWhen();
  const { rows, totals, ordered } = screen.sales;
  const collected = screen.collections;
  if (rows.length === 0 && collected.length === 0) return null;
  const parts: [string, number][] = [['Cash', totals.cash], ['M-Pesa and other mobile money', totals.mobileMoney], ['Card', totals.card], ['On account', totals.credit], ['Orders for later', ordered]];
  return (
    <section className={`${cardClass} space-y-3`} aria-label="Sales">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 basis-48 text-base font-bold text-fg-strong">Sales</h2>
        <span className="font-mono text-base font-bold text-fg-strong" data-testid="day-sales-total">{kes(totals.all)}</span>
      </div>
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        {parts.filter(([, n]) => n > 0).map(([label, n]) => (
          <div key={label} className="flex justify-between gap-3"><dt className="text-fg-muted">{label}</dt><dd className="font-mono">{kes(n)}</dd></div>
        ))}
      </dl>
      {rows.length === 0 ? null : (
      <ul className="space-y-2" aria-label="Sales made">
          {rows.map((r) => (
            <li key={r.orderId} className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-3 text-sm">
              <span className="min-w-0 flex-1 basis-40"><span className="font-semibold text-fg-strong">{r.customerName}</span> <span className="text-fg-muted">{r.orderNumber} · {when(r.at)}</span></span>
              {r.kind === 'credit' ? <Chip tone="amber">On account</Chip> : null}
              {r.kind === 'order' ? <Chip tone="sky">Order</Chip> : null}
              <span className="font-mono font-semibold">{kes(r.total)}</span>
            </li>
          ))}
        </ul>
      )}
      {collected.length === 0 ? null : (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-fg-strong">Money collected</h3>
          <ul className="space-y-2" aria-label="Money collected">
            {collected.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-3 text-sm">
                <span className="min-w-0 flex-1 basis-40"><span className="font-semibold text-fg-strong">{c.customerName}</span> <span className="text-fg-muted">{c.receiptNumber} · {when(c.at)}</span></span>
                <span className="font-mono font-semibold">{kes(c.amount)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
