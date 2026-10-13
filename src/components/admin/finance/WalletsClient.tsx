'use client';

import Link from 'next/link';
import type { walletReportAction } from '@/server/domains/finance/wallet-actions';
import { Chip, PageHeader, cardClass, money } from './ui';

type View = Extract<Awaited<ReturnType<typeof walletReportAction>>, { ok: true }>['data'];

export function WalletsClient({ view }: { view: View }) {
  const lc = view.label.toLowerCase();
  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader title={`${view.label} liability`} intro={`What the business owes customers who hold credit. It is a liability, not money you can spend: it comes off when the customer pays an invoice or an order with it.`} />
      {!view.walletEnabled ? <p className="text-sm text-amber-700">The {lc} is switched off. Existing balances can still be used. See Finance → Wallet policy.</p> : null}
      <section aria-label="Totals" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {view.totals.length === 0 ? <div className={cardClass}><p className="text-xs text-fg-muted">Owed to customers</p><p className="text-lg font-bold text-fg-strong">0.00</p></div> : null}
        {view.totals.map((t) => (
          <div key={t.currency} className={cardClass}>
            <p className="text-xs text-fg-muted">Owed to customers ({t.currency})</p>
            <p className="text-lg font-bold tabular-nums text-fg-strong">{money(t.total)}</p>
            <p className="text-[11px] text-fg-muted">{t.holders} {t.holders === 1 ? 'customer' : 'customers'}</p>
          </div>
        ))}
      </section>

      <section className="space-y-2" aria-labelledby="wallet-books">
        <h3 id="wallet-books" className="text-sm font-bold text-fg-strong">The books against the {lc}s</h3>
        {view.reconciliation.length === 0 ? <p className="text-sm text-fg-muted">No customer-deposits account is set on a customer posting group.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[28rem] text-left text-xs">
              <caption className="sr-only">The customer-deposits account in the general ledger compared with the customer wallets</caption>
              <thead className="text-fg-muted"><tr><th scope="col" className="py-1 pr-3">Account</th><th scope="col" className="pr-3 text-right">General ledger</th><th scope="col" className="pr-3 text-right">Wallets</th><th scope="col" className="text-right">Difference</th></tr></thead>
              <tbody>
                {view.reconciliation.map((r) => (
                  <tr key={r.accountNo} className="border-t border-line">
                    <td className="py-1.5 pr-3">{r.accountNo} {r.accountName}</td>
                    <td className="pr-3 text-right tabular-nums">{money(r.gl)}</td>
                    <td className="pr-3 text-right tabular-nums">{money(r.wallets)}</td>
                    <td className="text-right tabular-nums">{Number(r.diff) === 0 ? <Chip tone="green">Agrees</Chip> : <span className="font-semibold text-red-700">{money(r.diff)}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-fg-muted">Before sales are switched on for the general ledger the books do not hold wallets, so a difference is expected.</p>
      </section>

      <section className="space-y-2" aria-labelledby="wallet-top">
        <h3 id="wallet-top" className="text-sm font-bold text-fg-strong">Who holds the most</h3>
        {view.top.length === 0 ? <p className="text-sm text-fg-muted">No customer holds anything.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[26rem] text-left text-xs">
              <caption className="sr-only">Customers holding credit, largest first</caption>
              <thead className="text-fg-muted"><tr><th scope="col" className="py-1 pr-3">Customer</th><th scope="col" className="pr-3">State</th><th scope="col" className="text-right">Held</th></tr></thead>
              <tbody>
                {view.top.map((r) => (
                  <tr key={`${r.customerId}-${r.currency}`} className="border-t border-line">
                    <td className="py-1.5 pr-3"><Link className="font-semibold text-indigo-600 hover:underline" href={`/admin/finance/receivables/customer/${r.customerId}`}>{r.name}</Link> <span className="text-fg-muted">{r.number}</span></td>
                    <td className="pr-3">{r.status === 'frozen' ? <Chip tone="red">Frozen</Chip> : <Chip tone="green">Active</Chip>}</td>
                    <td className="text-right font-semibold tabular-nums">{r.currency} {money(r.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
