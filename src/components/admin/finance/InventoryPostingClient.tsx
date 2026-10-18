'use client';

import Link from 'next/link';
import { use, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { inventoryGoLiveAction, retryInventoryPostingAction, type inventoryPostingOverviewAction } from '@/server/domains/finance/inventory-posting-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { checkMark } from '@/lib/ledger-forms';
import type { Choice } from '@/lib/payment-options';
import { has } from '@/lib/values';
import { Chip, LoadFailed, Message, PageHeader, buttonClass, cardClass, money, primaryClass, type Notice, attempt } from './ui';

type View = Extract<Awaited<ReturnType<typeof inventoryPostingOverviewAction>>, { ok: true }>['data'];

export function InventoryPostingClient({ viewPromise }: { viewPromise: ReturnType<typeof inventoryPostingOverviewAction> }) {
  const res = use(viewPromise);
  return res.ok ? <InventoryPostingView view={res.data} /> : <LoadFailed error={res.error} />;
}

function InventoryPostingView({ view }: { view: View }) {
  const uid = useId();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [offset, setOffset] = useState<Choice | null>(null);
  const [confirm, setConfirm] = useState(false);
  const blocking = view.checks.filter((c) => c.blocking && !c.ok);

  const done = (res: { ok: true } | { ok: false; error: string }, ok: string) => {
    setBusy(false);
    setNotice(res.ok ? { kind: 'ok', text: ok } : { kind: 'error', text: res.error });
    router.refresh();
  };
  const live = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    const res = await attempt(inventoryGoLiveAction(offset?.id ?? ''));
    done(res, res.ok ? `Stock is now in the books, from ${res.data.date}. Opening stock at cost: ${view.baseCurrency} ${money(res.data.opening)}.` : '');
  };
  const retry = async (id?: number) => {
    setBusy(true);
    const res = await attempt(retryInventoryPostingAction(id));
    done(res, res.ok ? `${String(res.data.posted)} posted${res.data.failed > 0 ? `, ${String(res.data.failed)} still waiting` : ''}.` : '');
  };

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title="Stock in the books"
        intro="Stock is carried in the general ledger at cost. Goods received build it up, goods sold move their cost into cost of sales, goods that come back from a customer undo that, and counts, write-offs and changes of cost go through the adjustment account. Every change in stock is written down the moment it happens; if the accounts are not set up, it waits here, says why, and goes through once it is fixed."
      />
      <Message notice={notice} />

      <section className={`${cardClass} space-y-3`} aria-labelledby={`${uid}-st`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id={`${uid}-st`} className="text-sm font-bold text-fg-strong">Status</h3>
          {view.goLive === null ? <Chip tone="amber">Not in the books yet</Chip> : <Chip tone="green">In the books since {view.goLive}</Chip>}
        </div>
        <ul className="space-y-1.5" aria-label="Readiness">
          {view.checks.map((c) => {
            const mark = checkMark(c);
            return (
              <li key={c.key} className="flex items-start gap-2 text-sm">
                <span aria-hidden className={mark.tone}>{mark.mark}</span>
                <span><span className="sr-only">{mark.said}</span><span className="font-semibold text-fg-strong">{c.label}</span> <span className="text-fg-muted">— {c.detail}</span></span>
              </li>
            );
          })}
        </ul>
        <p className="text-xs text-fg-muted">The accounts are chosen on <Link className="text-indigo-600 hover:underline" href="/admin/finance/posting-setup">Posting setup</Link>. Stock is valued at each product&apos;s cost price; a change of cost revalues what is on the shelf.</p>
      </section>

      {view.goLive === null && view.can.goLive ? (
        <form onSubmit={(e) => void live(e)} className={`${cardClass} space-y-3`} aria-label="Put stock in the books">
          <h3 className="text-sm font-bold text-fg-strong">Put stock in the books</h3>
          <p className="text-sm text-fg">From today every change in stock posts. The stock on the shelves today, <strong className="tabular-nums">{view.baseCurrency} {money(view.stockValue)}</strong> at cost, comes in as an opening balance, so the books and the shelves start in agreement. This is done once.</p>
          <ChoicePicker label="Opening stock goes against" source="equity-gl-accounts" choice={offset} onChoice={setOffset} clearable={false} required placeholder="An equity account, such as opening balance equity" />
          <label className="flex min-h-10 items-start gap-2 text-sm text-fg">
            <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} className="mt-1 h-4 w-4" />
            I understand this starts the books for stock from today and cannot be undone.
          </label>
          {blocking.length > 0 ? <p role="alert" className="text-sm text-red-700">Fix the items marked ✗ above first.</p> : null}
          <button type="submit" className={primaryClass} disabled={busy || offset === null || !confirm || blocking.length > 0}>Put stock in the books</button>
        </form>
      ) : null}

      {view.reconciliation !== null && view.reconciliation.live ? (
        <section className={`${cardClass} space-y-2`} aria-label="The books against the shelves">
          <h3 className="text-sm font-bold text-fg-strong">The books against the shelves</h3>
          <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <div><dt className="text-xs text-fg-muted">Inventory in the ledger</dt><dd className="font-bold tabular-nums">{money(view.reconciliation.gl)}</dd></div>
            <div><dt className="text-xs text-fg-muted">Waiting to be posted</dt><dd className="font-bold tabular-nums">{money(view.reconciliation.waiting)} <span className="text-xs font-normal text-fg-muted">({view.reconciliation.waitingCount})</span></dd></div>
            <div><dt className="text-xs text-fg-muted">Units × cost on the shelves</dt><dd className="font-bold tabular-nums">{money(view.reconciliation.shelves)}</dd></div>
            <div><dt className="text-xs text-fg-muted">Difference</dt><dd>{Number(view.reconciliation.diff) === 0 ? <Chip tone="green">Agrees</Chip> : <span className="font-bold text-red-700" role="alert">{money(view.reconciliation.diff)}</span>}</dd></div>
          </dl>
          {Number(view.reconciliation.diff) === 0 ? null : <p className="text-xs text-fg-muted">A difference that the waiting changes do not explain means stock was changed some way that did not leave a record, or a cost was changed in the middle of a delivery. Count the stock and correct it with an adjustment.</p>}
        </section>
      ) : null}

      <section className="space-y-2" aria-labelledby={`${uid}-wait`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id={`${uid}-wait`} className="text-sm font-bold text-fg-strong">Waiting to be fixed ({view.counts.failed})</h3>
          {view.can.retry && view.counts.failed > 0 ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void retry()}>Retry all</button> : null}
        </div>
        {view.failed.length === 0 ? <p className="text-sm text-fg-muted">Nothing is waiting.</p> : (
          <ul className="space-y-2">
            {view.failed.map((e) => (
              <li key={e.id} className="rounded-xl border border-line bg-surface-raised p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="min-w-0 break-words font-semibold text-fg-strong">{e.what} <span className="font-normal text-fg-muted">· {e.quantity} × {e.unitCost} · {e.eventDate}</span></p>
                  <div className="flex items-center gap-2">
                    <Chip tone="red">{`Failed ×${String(e.attempts)}`}</Chip>
                    {view.can.retry ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void retry(e.id)} aria-label={`Retry ${e.what} on ${e.eventDate}`}>Retry</button> : null}
                  </div>
                </div>
                {has(e.lastError) ? <p className="mt-1 break-words text-xs text-red-700">{e.lastError}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2" aria-labelledby={`${uid}-recent`}>
        <h3 id={`${uid}-recent`} className="text-sm font-bold text-fg-strong">Last posted ({view.counts.posted} in all)</h3>
        {view.recent.length === 0 ? <p className="text-sm text-fg-muted">Nothing has been posted yet.</p> : (
          <ul className="space-y-1 text-sm">
            {view.recent.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-1.5">
                <span className="min-w-0 break-words">{e.what} <span className="text-fg-muted">· {e.quantity} × {e.unitCost} · {e.eventDate}</span></span>
                <span className="font-semibold tabular-nums">{view.baseCurrency} {money(e.value)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
