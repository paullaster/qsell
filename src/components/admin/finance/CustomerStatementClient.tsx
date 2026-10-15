'use client';

import Link from 'next/link';
import { Suspense, use, useId, useState } from 'react';
import { customerStatementAction } from '@/server/domains/finance/receivables/actions';
import type { customerWalletAction } from '@/server/domains/finance/wallet-actions';
import { CustomerWalletPanel } from './CustomerWalletPanel';
import { Chip, Field, LoadFailed, Message, PageHeader, buttonClass, cardClass, fieldClass, money, primaryClass, type Notice, attempt } from './ui';

type View = Extract<Awaited<ReturnType<typeof customerStatementAction>>, { ok: true }>['data'];

const TYPE_LABEL: Record<string, string> = { invoice: 'Invoice', payment: 'Payment', credit_note: 'Credit note', refund: 'Refund' };

interface Props {
  statementPromise: ReturnType<typeof customerStatementAction>;
  walletPromise: ReturnType<typeof customerWalletAction>;
  canReceivePromise: Promise<boolean>;
}

export function CustomerStatementClient({ statementPromise, walletPromise, canReceivePromise }: Props) {
  const statement = use(statementPromise);
  const canReceive = use(canReceivePromise);
  if (!statement.ok) return <LoadFailed error={statement.error} />;
  return <CustomerStatementView initial={statement.data} canReceive={canReceive} walletPromise={walletPromise} />;
}

/** The wallet loads on its own, so the statement never waits for it. */
function WalletSection({ customerId, walletPromise }: { customerId: string; walletPromise: ReturnType<typeof customerWalletAction> }) {
  const wallet = use(walletPromise);
  return wallet.ok ? <CustomerWalletPanel customerId={customerId} view={wallet.data} /> : null;
}

function CustomerStatementView({ initial, canReceive, walletPromise }: { initial: View; canReceive: boolean; walletPromise: ReturnType<typeof customerWalletAction> }) {
  const uid = useId();
  // The position (owed, ageing) always follows the page; only the list of entries is what a date range replaces.
  const [ranged, setRanged] = useState<View['lines'] | null>(null);
  const view = ranged === null ? initial : { ...initial, lines: ranged };
  const [range, setRange] = useState({ from: '', to: '' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const refresh = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    const res = await attempt(customerStatementAction(view.customer.id, range.from === '' ? undefined : range.from, range.to === '' ? undefined : range.to));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setNotice(null);
    setRanged(res.data.lines);
  };
  const c = view.customer;

  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader
        title={c.name}
        intro={<span className="flex flex-wrap items-center gap-2">Customer {c.number} · <Chip tone={c.accountType === 'credit' ? 'sky' : 'gray'}>{c.accountType === 'credit' ? 'Credit account' : 'Cash customer'}</Chip>{c.blocked !== 'none' ? <Chip tone="red">Blocked: {c.blocked}</Chip> : null}</span>}
        actions={canReceive ? <Link className={primaryClass} href={`/admin/finance/receipts/new?customer=${encodeURIComponent(c.number)}`}>Record a receipt</Link> : null}
      />
      <Message notice={notice} />
      <section aria-label="Position" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className={cardClass}><p className="text-xs text-fg-muted">Owes</p><p className="text-lg font-bold tabular-nums text-fg-strong">{money(view.owed)}</p></div>
        <div className={cardClass}><p className="text-xs text-fg-muted">Receipts not yet applied</p><p className="text-lg font-bold tabular-nums text-fg-strong">{money(view.unapplied)}</p></div>
        <div className={cardClass}><p className="text-xs text-fg-muted">Net position</p><p className="text-lg font-bold tabular-nums text-fg-strong">{money(view.net)}</p></div>
        <div className={cardClass}><p className="text-xs text-fg-muted">Credit limit</p><p className="text-lg font-bold tabular-nums text-fg-strong">{c.accountType === 'credit' ? money(c.creditLimit) : '—'}</p></div>
      </section>

      <Suspense fallback={<p className="text-xs text-fg-muted" role="status">Loading the wallet…</p>}>
        <WalletSection customerId={c.id} walletPromise={walletPromise} />
      </Suspense>

      <section aria-labelledby={`${uid}-age`} className="space-y-2">
        <h3 id={`${uid}-age`} className="text-sm font-bold text-fg-strong">By age</h3>
        <ul className="grid grid-cols-2 gap-2 md:grid-cols-5">
          {view.ageing.map((b) => (
            <li key={b.label} className="rounded-xl border border-line bg-surface-raised p-3">
              <p className="text-xs text-fg-muted">{b.label}</p>
              <p className="text-sm font-bold tabular-nums text-fg-strong">{money(b.amount)}</p>
              <p className="text-[11px] text-fg-muted">{b.count} {b.count === 1 ? 'invoice' : 'invoices'}</p>
            </li>
          ))}
        </ul>
      </section>

      <form onSubmit={refresh} className={`${cardClass} grid grid-cols-1 gap-3 sm:grid-cols-4`} aria-label="Date range">
        <Field id={`${uid}-from`} label="From"><input id={`${uid}-from`} type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} className={fieldClass} /></Field>
        <Field id={`${uid}-to`} label="To"><input id={`${uid}-to`} type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} className={fieldClass} /></Field>
        <div className="flex items-end"><button type="submit" className={buttonClass} disabled={busy}>Show</button></div>
      </form>

      {view.lines.length === 0 ? (
        <p className="text-sm text-fg-muted">No entries in this range.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-left text-xs">
            <caption className="sr-only">Customer ledger entries, newest first</caption>
            <thead className="text-fg-muted">
              <tr><th scope="col" className="py-2 pr-3">Date</th><th scope="col" className="pr-3">Document</th><th scope="col" className="pr-3">Description</th><th scope="col" className="pr-3">Due</th><th scope="col" className="pr-3 text-right">Amount</th><th scope="col" className="text-right">Still open</th></tr>
            </thead>
            <tbody>
              {view.lines.map((l) => (
                <tr key={l.id} className="border-t border-line">
                  <td className="py-1.5 pr-3 whitespace-nowrap">{l.date ?? ''}</td>
                  <td className="pr-3 whitespace-nowrap">
                    {TYPE_LABEL[l.type] ?? l.type}{' '}
                    {l.type === 'payment' && l.documentId !== null && l.documentId !== '' ? <Link className="font-semibold text-indigo-600 hover:underline" href={`/admin/finance/receipts/${l.documentId}`}>{l.documentNo}</Link> : <span className="font-semibold">{l.documentNo}</span>}
                  </td>
                  <td className="pr-3">{l.description}</td>
                  <td className="pr-3 whitespace-nowrap">{l.dueDate ?? ''}</td>
                  <td className={`pr-3 text-right tabular-nums ${l.amount.startsWith('-') ? 'text-emerald-700' : ''}`}>{money(l.amount)} {l.currency ?? ''}</td>
                  <td className="text-right tabular-nums">{Number(l.remaining) === 0 ? <Chip tone="gray">Settled</Chip> : money(l.remaining)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px] text-fg-muted">Payments show as negative amounts. “Still open” on a payment is what has not yet been applied to invoices.</p>
    </div>
  );
}
