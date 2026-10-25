'use client';

import Link from 'next/link';
import { use } from 'react';
import type { notInvoicedAction } from '@/server/domains/vendors/rgn-actions';
import { LoadFailed, PageHeader, buttonClass, cardClass } from '@/components/ui/screen-kit';

type Report = Extract<Awaited<ReturnType<typeof notInvoicedAction>>, { ok: true }>['data'];

export function NotInvoicedClient({ reportPromise }: { reportPromise: ReturnType<typeof notInvoicedAction> }) {
  const res = use(reportPromise);
  return res.ok ? <View report={res.data} /> : <LoadFailed error={res.error} />;
}

const money = (v: number): string => v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function View({ report }: { report: Report }) {
  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader title="Received, not yet invoiced" intro="Goods that arrived and that the vendor has not invoiced, oldest first. The total is what sits in stock received not invoiced." actions={<Link href="/admin/vendors/receipts" className={buttonClass}>Received goods</Link>} />
      <p className="text-sm text-fg" aria-live="polite">Total: <span className="font-semibold">{money(report.totalValue)}</span></p>
      {report.rows.length === 0 ? <p className={`${cardClass} text-sm text-fg-muted`}>Everything received has been invoiced.</p> : (
        <>
          <ul className="space-y-2 md:hidden" aria-label="Received, not invoiced">
            {report.rows.map((r) => <li key={`${r.rgn}-${r.description}`} className={cardClass}><p className="text-sm font-bold text-fg-strong">{r.description}</p><p className="text-xs text-fg-muted">{r.vendor} · {r.rgn} · {r.po ?? ''}</p><p className="mt-1 text-sm text-fg">{r.openQuantity} {r.unit} · {money(Number(r.value))} · {r.ageDays} days</p></li>)}
          </ul>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">Goods received and not yet invoiced</caption>
              <thead className="text-fg-muted"><tr><th scope="col" className="py-2 pr-3">Vendor</th><th scope="col" className="pr-3">Note</th><th scope="col" className="pr-3">Order</th><th scope="col" className="pr-3">Item</th><th scope="col" className="pr-3 text-right">Quantity</th><th scope="col" className="pr-3 text-right">Value</th><th scope="col" className="text-right">Days</th></tr></thead>
              <tbody>
                {report.rows.map((r) => <tr key={`${r.rgn}-${r.description}`} className="border-t border-line"><td className="py-2 pr-3">{r.vendor}</td><td className="pr-3">{r.rgn}</td><td className="pr-3">{r.po ?? ''}</td><td className="pr-3">{r.description}</td><td className="pr-3 text-right tabular-nums">{r.openQuantity} {r.unit}</td><td className="pr-3 text-right tabular-nums">{money(Number(r.value))}</td><td className="text-right tabular-nums">{r.ageDays}</td></tr>)}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
