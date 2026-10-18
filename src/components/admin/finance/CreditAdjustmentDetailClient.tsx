'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import { cancelCreditAdjustmentAction, decideCreditAdjustmentAction, type creditAdjustmentDetailAction } from '@/server/domains/finance/credit-adjustment-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { ADJUSTMENT_KIND, ADJUSTMENT_STATUS, statusInfo } from '@/lib/finance-statuses';
import { KIND_SENTENCE, wordsOf } from '@/lib/credit-adjustment-form';
import { has, historyDetail, historyHeadline, historyReason } from '@/lib/finance-history';
import { needsComment } from '@/lib/receipt-detail';
import type { Choice } from '@/lib/payment-options';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, dangerClass, fieldClass, money, primaryClass, type Notice } from './ui';

type View = Extract<Awaited<ReturnType<typeof creditAdjustmentDetailAction>>, { ok: true }>['data'];

export function CreditAdjustmentDetailClient({ viewPromise }: { viewPromise: ReturnType<typeof creditAdjustmentDetailAction> }) {
  const res = use(viewPromise);
  return res.ok ? <CreditAdjustmentView view={res.data} /> : <LoadFailed error={res.error} />;
}

function CreditAdjustmentView({ view }: { view: View }) {
  const router = useRouter();
  const [panel, setPanel] = useState<null | 'reject' | 'cancel'>(null);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState<Choice | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const done = (res: { ok: true } | { ok: false; error: string }, okText: string) => {
    setBusy(false);
    if (!res.ok) { setNotice({ kind: 'error', text: res.error }); return; }
    setNotice({ kind: 'ok', text: okText });
    setPanel(null);
    router.refresh();
  };
  const approve = async () => { setBusy(true); setNotice(null); done(await attempt(decideCreditAdjustmentAction(view.id, 'approve')), 'Approved and done.'); };
  const reject = async (e: React.SyntheticEvent) => { e.preventDefault(); setBusy(true); setNotice(null); done(await attempt(decideCreditAdjustmentAction(view.id, 'reject', note)), 'Turned down. Nothing changed.'); };
  const cancel = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    const text = note.trim();
    done(await attempt(cancelCreditAdjustmentAction(view.id, { code: reason?.id ?? '', text: text === '' ? undefined : text })), 'Cancelled.');
  };

  const status = statusInfo(ADJUSTMENT_STATUS, view.status);
  const kind = statusInfo(ADJUSTMENT_KIND, view.kind);
  const sentence = Object.hasOwn(KIND_SENTENCE, view.kind) ? KIND_SENTENCE[view.kind] : '';
  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title={`Credit adjustment ${view.number}`}
        intro={<span className="flex flex-wrap items-center gap-2"><Chip tone={kind.tone}>{kind.label}</Chip><Chip tone={status.tone}>{status.label}</Chip><span>for <Link className="font-semibold text-indigo-600 hover:underline" href={`/admin/finance/receivables/customer/${view.customer.id}`}>{view.customer.name}</Link> ({view.customer.number})</span></span>}
        actions={<Link href="/admin/finance/receivables/credit-adjustments" className={buttonClass}>All adjustments</Link>}
      />
      <Message notice={notice} />
      {sentence === '' ? null : <p className="text-sm text-fg" role="note">{sentence}</p>}
      <section className={`${cardClass} grid grid-cols-2 gap-x-4 gap-y-3 text-sm md:grid-cols-4`} aria-label="Details">
        {([['Amount', `${view.currency} ${money(view.amount)}`], ['Credit', has(view.source) ? view.source : 'Wallet'], ['Reason', `${wordsOf(view.reason)}${has(view.reasonText) ? ` — ${view.reasonText}` : ''}`], ['Asked by', view.requestedBy ?? '—'], ['Decided by', view.decidedBy ?? (view.status === 'applied' ? 'Approval workflow' : '—')], ['Decided on', view.decidedAt === null ? '—' : new Date(view.decidedAt).toLocaleString()]] as [string, string][]).map(([k, v]) => (
          <div key={k}><dt className="text-xs text-fg-muted">{k}</dt><dd className="break-words font-semibold text-fg-strong">{v}</dd></div>
        ))}
      </section>

      <div className="flex flex-wrap gap-2">
        {view.can.decide ? <button type="button" className={primaryClass} disabled={busy} onClick={() => void approve()}>Approve</button> : null}
        {view.can.decide ? <button type="button" className={dangerClass} disabled={busy} aria-expanded={panel === 'reject'} onClick={() => setPanel('reject')}>Turn down…</button> : null}
        {view.can.cancel ? <button type="button" className={buttonClass} disabled={busy} aria-expanded={panel === 'cancel'} onClick={() => setPanel('cancel')}>Cancel the request…</button> : null}
      </div>
      {view.status === 'requested' && !view.can.decide ? <p className="text-sm text-fg-muted">Waiting for someone other than the person who asked to decide it.</p> : null}

      {panel === 'reject' ? (
        <form onSubmit={(e) => void reject(e)} className={`${cardClass} space-y-3`} aria-label="Turn it down">
          <Field id="rj-note" label="Why are you turning it down?"><input id="rj-note" value={note} onChange={(e) => setNote(e.target.value)} className={fieldClass} required minLength={3} maxLength={300} autoComplete="off" /></Field>
          <div className="flex gap-2"><button type="submit" className={dangerClass} disabled={busy || note.trim().length < 3}>Turn it down</button><button type="button" className={buttonClass} onClick={() => setPanel(null)}>Close</button></div>
        </form>
      ) : null}
      {panel === 'cancel' ? (
        <form onSubmit={(e) => void cancel(e)} className={`${cardClass} space-y-3`} aria-label="Cancel the request">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <ChoicePicker label="Reason" source="adjustment-reasons" choice={reason} onChoice={setReason} clearable={false} required placeholder="Choose a reason…" />
            <Field id="cn-note" label={needsComment(reason?.meta) ? 'Explain (required)' : 'Comment (optional)'}><input id="cn-note" value={note} onChange={(e) => setNote(e.target.value)} className={fieldClass} required={needsComment(reason?.meta)} maxLength={300} autoComplete="off" /></Field>
          </div>
          <div className="flex gap-2"><button type="submit" className={dangerClass} disabled={busy || reason === null}>Cancel the request</button><button type="button" className={buttonClass} onClick={() => setPanel(null)}>Keep it</button></div>
        </form>
      ) : null}

      <section className={`${cardClass} space-y-2`} aria-label="History">
        <h2 className="text-sm font-bold text-fg-strong">History</h2>
        <ol className="space-y-2 text-sm">
          {view.events.map((e) => (
            <li key={e.id} className="border-l-2 border-line pl-3">
              <p className="font-semibold text-fg-strong">{historyHeadline(e)}</p>
              <p className="text-xs text-fg-muted">{historyDetail(e, (iso) => new Date(iso).toLocaleString())}{has(e.reasonCode) ? ` · ${historyReason(e)}` : ''}</p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
