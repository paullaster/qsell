'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  goLiveAction,
  retrySalesPostingAction,
  setOutputTaxAccountAction,
  type salesPostingOverviewAction,
} from '@/server/domains/finance/sales-actions';
import { Chip, Field, Message, PageHeader, buttonClass, cardClass, fieldClass, money, primaryClass, type Notice, attempt } from './ui';

type View = Extract<Awaited<ReturnType<typeof salesPostingOverviewAction>>, { ok: true }>['data'];

const KIND: Record<string, string> = {
  invoice: 'Credit invoice',
  cash_sale: 'Cash sale',
  credit_payment: 'Payment of a credit order',
  rebate_credit: 'Rebate',
};

export function SalesPostingClient({ view }: { view: View }) {
  const uid = useId();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [tax, setTax] = useState(view.outputTaxAccountId ?? '');
  const [offset, setOffset] = useState('');
  const [confirm, setConfirm] = useState(false);
  const blocking = view.checks.filter((c) => c.blocking && !c.ok);

  const done = (res: { ok: true } | { ok: false; error: string }, ok: string) => {
    setBusy(false);
    setNotice(res.ok ? { kind: 'ok', text: ok } : { kind: 'error', text: res.error });
    router.refresh();
  };
  const saveTax = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    done(await attempt(setOutputTaxAccountAction(tax)), 'Saved.');
  };
  const live = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const res = await attempt(goLiveAction(offset));
    done(res, res.ok ? `Sales now post to the general ledger, from ${res.data.date}. ${res.data.opening.length} opening balance${res.data.opening.length === 1 ? '' : 's'} brought in.` : '');
  };
  const retry = async (id?: string) => {
    setBusy(true);
    const res = await attempt(retrySalesPostingAction(id));
    done(res, res.ok ? `${res.data.posted} posted, ${res.data.failed} still waiting.` : '');
  };

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title="Sales posting"
        intro="How sales reach the general ledger. A credit invoice posts when it is issued; a cash sale posts when it is paid; payments and rebates post as they happen. The sale is always saved first: if the accounts are not set up, the posting waits here, says why, and goes through once it is fixed."
      />
      <Message notice={notice} />

      <section className={`${cardClass} space-y-3`} aria-labelledby={`${uid}-st`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id={`${uid}-st`} className="text-sm font-bold text-fg-strong">Status</h3>
          {view.goLive ? <Chip tone="green">Live since {view.goLive}</Chip> : <Chip tone="amber">Not live: sales do not reach the general ledger yet</Chip>}
        </div>
        <ul className="space-y-1.5" aria-label="Readiness">
          {view.checks.map((c) => (
            <li key={c.key} className="flex items-start gap-2 text-sm">
              <span aria-hidden className={c.ok ? 'text-emerald-600' : c.blocking ? 'text-red-600' : 'text-amber-600'}>{c.ok ? '✓' : c.blocking ? '✗' : '!'}</span>
              <span><span className="sr-only">{c.ok ? 'Done: ' : 'To do: '}</span><span className="font-semibold text-fg-strong">{c.label}</span> <span className="text-fg-muted">— {c.detail}</span></span>
            </li>
          ))}
        </ul>
        {view.can.setTax ? (
          <form onSubmit={saveTax} className="grid grid-cols-1 items-end gap-3 sm:grid-cols-3" aria-label="Tax account">
            <div className="sm:col-span-2">
              <Field id={`${uid}-tax`} label="Account for tax owed on sales" hint="Output VAT or sales tax payable: a liability account.">
                <select id={`${uid}-tax`} value={tax} onChange={(e) => setTax(e.target.value)} className={fieldClass} required>
                  <option value="">Choose…</option>
                  {view.liabilityAccounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                </select>
              </Field>
            </div>
            <button type="submit" className={buttonClass} disabled={busy || !tax || tax === view.outputTaxAccountId}>Save tax account</button>
          </form>
        ) : null}
        <p className="text-xs text-fg-muted">The other accounts are edited on <Link className="text-indigo-600 hover:underline" href="/admin/finance/posting-setup">Posting setup</Link>.</p>
      </section>

      {!view.goLive && view.can.goLive ? (
        <form onSubmit={live} className={`${cardClass} space-y-3`} aria-labelledby={`${uid}-gl`}>
          <h3 id={`${uid}-gl`} className="text-sm font-bold text-fg-strong">Switch sales on for the general ledger</h3>
          <p className="text-sm text-fg">
            From today, every sale posts. What customers owe today is brought in as an opening balance, so the ledger and the customer accounts start in agreement. This is done once.
          </p>
          {view.opening.length === 0 ? (
            <p className="text-sm text-fg-muted">Customers owe nothing today, so there is no opening balance.</p>
          ) : (
            <ul className="text-sm">
              {view.opening.map((o) => (
                <li key={o.group}>Customer group <span className="font-mono">{o.group}</span>: <strong className="tabular-nums">{view.baseCurrency} {money(o.amount)}</strong>{o.foreignEntries > 0 ? <span className="text-amber-700"> ({o.foreignEntries} foreign-currency entries are not included)</span> : null}</li>
              ))}
            </ul>
          )}
          <Field id={`${uid}-off`} label="Opening balance goes against" hint="An equity account, for example opening balance equity or retained earnings.">
            <select id={`${uid}-off`} value={offset} onChange={(e) => setOffset(e.target.value)} className={fieldClass} required>
              <option value="">Choose…</option>
              {view.equityAccounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          </Field>
          <label className="flex min-h-10 items-start gap-2 text-sm text-fg">
            <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} className="mt-1 h-4 w-4" />
            I understand this starts the books for sales from today and cannot be undone.
          </label>
          {blocking.length > 0 ? <p role="alert" className="text-sm text-red-700">Fix the items marked ✗ above first.</p> : null}
          <button type="submit" className={primaryClass} disabled={busy || !offset || !confirm || blocking.length > 0}>Switch on</button>
        </form>
      ) : null}

      <section className="space-y-2" aria-labelledby={`${uid}-wait`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id={`${uid}-wait`} className="text-sm font-bold text-fg-strong">Waiting to be posted ({view.backlog.pending + view.backlog.failed})</h3>
          {view.can.retry && view.backlog.failed > 0 ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void retry()}>Retry all that failed</button> : null}
        </div>
        {view.open.length === 0 ? (
          <p className="text-sm text-fg-muted">Nothing is waiting.</p>
        ) : (
          <ul className="space-y-2">
            {view.open.map((r) => (
              <li key={r.id} className="rounded-xl border border-line bg-surface-raised p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold text-fg-strong">{KIND[r.kind] ?? r.kind} <span className="font-normal text-fg-muted">· {r.eventDate} · {r.subjectId.slice(0, 18)}</span></p>
                  <div className="flex items-center gap-2">
                    <Chip tone={r.status === 'failed' ? 'red' : 'amber'}>{r.status === 'failed' ? `Failed ×${r.attempts}` : 'Queued'}</Chip>
                    {view.can.retry ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void retry(r.id)} aria-label={`Retry ${KIND[r.kind] ?? r.kind} ${r.subjectId.slice(0, 18)}`}>Retry</button> : null}
                  </div>
                </div>
                {r.lastError ? <p className="mt-1 text-xs text-red-700">{r.lastError}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2" aria-labelledby={`${uid}-rec`}>
        <h3 id={`${uid}-rec`} className="text-sm font-bold text-fg-strong">Receivables: the books against the customer accounts</h3>
        {view.reconciliation.length === 0 ? <p className="text-sm text-fg-muted">No receivables account is set on a customer posting group.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[30rem] text-left text-xs">
              <caption className="sr-only">The receivables account in the general ledger compared with what customers owe</caption>
              <thead className="text-fg-muted"><tr><th scope="col" className="py-1 pr-3">Account</th><th scope="col" className="pr-3 text-right">General ledger</th><th scope="col" className="pr-3 text-right">Customer accounts</th><th scope="col" className="text-right">Difference</th></tr></thead>
              <tbody>
                {view.reconciliation.map((r) => (
                  <tr key={r.accountNo} className="border-t border-line">
                    <td className="py-1.5 pr-3">{r.accountNo} {r.accountName}</td>
                    <td className="pr-3 text-right tabular-nums">{money(r.gl)}</td>
                    <td className="pr-3 text-right tabular-nums">{money(r.subLedger)}</td>
                    <td className="text-right tabular-nums">{Number(r.diff) === 0 ? <Chip tone="green">Agrees</Chip> : <span className="font-semibold text-red-700">{money(r.diff)}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-fg-muted">
          A difference is normal while sales are waiting above, or before they go live. Credit notes will join this in a later step; foreign-currency entries are left out of the comparison.
        </p>
      </section>
    </div>
  );
}
