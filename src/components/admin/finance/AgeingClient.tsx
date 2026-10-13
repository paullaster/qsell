'use client';

import Link from 'next/link';
import type { receivablesAgeingAction } from '@/server/domains/finance/receivables/actions';
import { PageHeader, cardClass, money } from './ui';

type View = Extract<Awaited<ReturnType<typeof receivablesAgeingAction>>, { ok: true }>['data'];

const COLS: [keyof View['totals'], string][] = [
  ['current', 'Not yet due'], ['d1_30', '1–30 days'], ['d31_60', '31–60 days'], ['d61_90', '61–90 days'], ['d90_plus', 'Over 90 days'],
];

export function AgeingClient({ view }: { view: View }) {
  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader
        title="Receivables ageing"
        intro="What customers owe, by how long it has been due. Unapplied receipts are shown beside the debt, never subtracted from the oldest invoice without anyone deciding to."
      />
      <section aria-label="Totals" className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <div className={cardClass}><p className="text-xs text-fg-muted">Total owed</p><p className="text-lg font-bold tabular-nums text-fg-strong">{money(view.totals.owed)}</p></div>
        {COLS.map(([k, label]) => (
          <div key={k} className={cardClass}><p className="text-xs text-fg-muted">{label}</p><p className="text-lg font-bold tabular-nums text-fg-strong">{money(view.totals[k])}</p></div>
        ))}
      </section>
      <p className="text-xs text-fg-muted">Unapplied receipts held for customers: <strong className="tabular-nums">{money(view.totals.credits)}</strong>. {view.truncated ? 'Showing the customers who owe most.' : ''}</p>
      {view.rows.length === 0 ? (
        <p className="text-sm text-fg-muted">Nobody owes anything.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[44rem] text-left text-xs">
            <caption className="sr-only">Amounts owed by customer and age</caption>
            <thead className="text-fg-muted">
              <tr>
                <th scope="col" className="py-2 pr-3">Customer</th>
                {COLS.map(([k, label]) => <th key={k} scope="col" className="pr-3 text-right">{label}</th>)}
                <th scope="col" className="pr-3 text-right">Owed</th>
                <th scope="col" className="text-right">Unapplied receipts</th>
              </tr>
            </thead>
            <tbody>
              {view.rows.map((r) => (
                <tr key={r.id} className="border-t border-line">
                  <td className="py-2 pr-3"><Link className="font-semibold text-indigo-600 hover:underline" href={`/admin/finance/receivables/customer/${r.id}`}>{r.name}</Link> <span className="text-fg-muted">{r.number}</span></td>
                  <td className="pr-3 text-right tabular-nums">{money(r.current)}</td>
                  <td className="pr-3 text-right tabular-nums">{money(r.d1_30)}</td>
                  <td className="pr-3 text-right tabular-nums">{money(r.d31_60)}</td>
                  <td className="pr-3 text-right tabular-nums">{money(r.d61_90)}</td>
                  <td className="pr-3 text-right tabular-nums font-semibold text-red-700">{money(r.d90_plus)}</td>
                  <td className="pr-3 text-right font-semibold tabular-nums">{money(r.owed)}</td>
                  <td className="text-right tabular-nums">{money(r.credits)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
