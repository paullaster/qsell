'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { creditQueueAction } from '@/server/domains/vendors/credit-memo-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { CREDIT_STATE } from '@/lib/vendor-credit-memo';
import type { Choice } from '@/lib/payment-options';
import { Chip, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, type Notice } from '@/components/ui/screen-kit';

type Page = Extract<Awaited<ReturnType<typeof creditQueueAction>>, { ok: true }>['data'];

export function CreditQueueClient({ initialPromise }: { initialPromise: ReturnType<typeof creditQueueAction> }) {
  const res = use(initialPromise);
  return res.ok ? <QueueView initial={res.data} /> : <LoadFailed error={res.error} />;
}

function QueueView({ initial }: { initial: Page }) {
  const [page, setPage] = useState(initial);
  const [state, setState] = useState<Choice | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const load = async (s: Choice | null, before: Page['next'], append: boolean) => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(creditQueueAction({ state: s?.id, before }));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setPage((cur) => ({ rows: append ? [...cur.rows, ...res.data.rows] : res.data.rows, next: res.data.next }));
  };
  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader title="Credit memos" intro="Credit notes vendors sent for invoices they billed too high. Open one to check it against the invoice and move it on." />
      <Message notice={notice} />
      <div className={`${cardClass} max-w-xs`}><ChoicePicker label="Stage" source="credit-memo-states" choice={state} onChoice={(c) => { setState(c); void load(c, null, false); }} placeholder="All open credit memos" /></div>
      {page.rows.length === 0 ? <p className="text-sm text-fg-muted">{busy ? 'Loading…' : 'No credit memos here.'}</p> : (
        <ul className="space-y-2" aria-label="Credit memos">
          {page.rows.map((r) => {
            const s = CREDIT_STATE[r.state];
            return (
              <li key={r.id}>
                <Link href={`/admin/vendors/credit-memos/${r.id}`} className={`${cardClass} flex min-h-10 flex-wrap items-center justify-between gap-2 hover:bg-hover`}>
                  <span className="min-w-0"><span className="block text-sm font-bold text-fg-strong">{r.number ?? 'No number'} · {r.vendorName}</span><span className="block text-xs text-fg-muted">Their number {r.vendorCreditNo} · for invoice {r.invoiceNo} · {r.total} {r.currency}{r.revision > 1 ? ` · version ${String(r.revision)}` : ''}</span></span>
                  <Chip tone={s.tone}>{s.label}</Chip>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {page.next === null ? null : <button type="button" className={buttonClass} disabled={busy} onClick={() => void load(state, page.next, true)}>Show older credit memos</button>}
    </div>
  );
}
