'use client';

import Link from 'next/link';
import { use, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { closeReturnAction, confirmReturnAction, type returnDetailAction } from '@/server/domains/returns/actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { roundQty } from '@/lib/decimal';
import { RETURN_STATUS, blankEntries, blankEntry, conditionLabel, confirmItems, confirmedMessage, dispositionLabel, nothingTyped, type Entry } from '@/lib/return-form';
import { statusInfo } from '@/lib/finance-statuses';
import { needsComment } from '@/lib/receipt-detail';
import { has } from '@/lib/finance-history';
import type { Choice } from '@/lib/payment-options';
import { Chip, Field, LoadFailed, Message, PageHeader, buttonClass, cardClass, dangerClass, fieldClass, primaryClass, type Notice, attempt } from './ui';

type View = Extract<Awaited<ReturnType<typeof returnDetailAction>>, { ok: true }>['data'];

export function ReturnDetailClient({ viewPromise }: { viewPromise: ReturnType<typeof returnDetailAction> }) {
  const res = use(viewPromise);
  return res.ok ? <ReturnDetailView view={res.data} /> : <LoadFailed error={res.error} />;
}

function ReturnDetailView({ view }: { view: View }) {
  const uid = useId();
  const router = useRouter();
  const open = !view.closed;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const lineIds = view.lines.map((l) => l.id);
  // A line sold in a crate is counted in crates; the server turns that into kilograms with the line's own conversion.
  const unitOf = Object.fromEntries(view.lines.map((l) => [l.id, l.unit?.id ?? null]));
  const [entries, setEntries] = useState<Record<string, Entry>>(() => blankEntries(lineIds, view.suggested));
  const [closing, setClosing] = useState(false);
  const [reason, setReason] = useState<Choice | null>(null);
  const [reasonText, setReasonText] = useState('');
  const set = (id: string, patch: Partial<Entry>) => setEntries((e) => ({ ...e, [id]: { ...(Object.hasOwn(e, id) ? e[id] : blankEntry(view.suggested)), ...patch } }));

  const confirm = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    const res = await attempt(confirmReturnAction(view.id, confirmItems(lineIds, entries, unitOf)));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setNotice({ kind: 'ok', text: confirmedMessage(res.data.stockAdded) });
    setEntries(blankEntries(lineIds, view.suggested));
    router.refresh();
  };
  const close = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    const text = reasonText.trim();
    const res = await attempt(closeReturnAction(view.id, { code: reason?.id ?? '', text: text === '' ? undefined : text }));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setNotice({ kind: 'ok', text: 'Closed. Nothing more is expected.' });
    setClosing(false);
    router.refresh();
  };

  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader
        title={`Return ${view.number}`}
        intro={<span className="flex flex-wrap items-center gap-2"><Chip tone={statusInfo(RETURN_STATUS, view.status).tone}>{statusInfo(RETURN_STATUS, view.status).label}</Chip><span>Credit note {view.creditNoteNo} · order {view.order}</span></span>}
        actions={<Link href="/admin/finance/receivables/returns" className={buttonClass}>All returns</Link>}
      />
      <Message notice={notice} />

      <form onSubmit={confirm} className="space-y-3" aria-label="Confirm goods that arrived">
        {view.lines.map((l) => {
          const left = roundQty(l.expected - l.received);
          const leftInUnit = roundQty(left / l.perUnit);
          const en = Object.hasOwn(entries, l.id) ? entries[l.id] : blankEntry(view.suggested);
          return (
            <div key={l.id} className={`${cardClass} space-y-3`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-bold text-fg-strong">{l.description}</p>
                <p className="text-xs text-fg-muted">{l.receivedWords} of {l.expectedWords} received{has(l.unitCost) ? ` · cost ${Number(l.unitCost).toFixed(2)} each` : ''}</p>
              </div>
              {open && view.can.confirm && left > 0 ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                  <Field id={`${uid}-q-${l.id}`} label={l.unit === null ? `How many arrived (up to ${String(left)})` : `How many ${l.unit.code} arrived (up to ${String(leftInUnit)})`}>
                    <input id={`${uid}-q-${l.id}`} value={en.qty} onChange={(e) => set(l.id, { qty: e.target.value })} className={fieldClass} inputMode="decimal" placeholder="0" autoComplete="off" />
                  </Field>
                  <ChoicePicker label="Condition" source="return-conditions" choice={en.condition} onChoice={(c) => set(l.id, { condition: c ?? en.condition })} clearable={false} required />
                  <ChoicePicker label="What was done with it" source="return-dispositions" choice={en.disposition} onChoice={(c) => set(l.id, { disposition: c ?? en.disposition })} clearable={false} required />
                  <Field id={`${uid}-n-${l.id}`} label="Note (optional)">
                    <input id={`${uid}-n-${l.id}`} value={en.note} onChange={(e) => set(l.id, { note: e.target.value })} className={fieldClass} maxLength={200} autoComplete="off" />
                  </Field>
                </div>
              ) : null}
            </div>
          );
        })}
        {open && view.can.confirm ? (
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={primaryClass} disabled={busy || nothingTyped(lineIds, entries)}>Confirm what arrived</button>
            {view.can.reject ? <button type="button" className={dangerClass} disabled={busy} onClick={() => setClosing((v) => !v)} aria-expanded={closing}>The rest is not coming</button> : null}
          </div>
        ) : null}
        {open && !view.can.confirm ? <p className="text-sm text-fg-muted">You may view this return, but confirming goods needs another permission.</p> : null}
      </form>

      {closing ? (
        <form onSubmit={close} className={`${cardClass} space-y-3`} aria-label="Close this return">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <ChoicePicker label="Reason" source="return-close-reasons" choice={reason} onChoice={setReason} clearable={false} required placeholder="Choose a reason…" />
            <Field id={`${uid}-rt`} label={needsComment(reason?.meta) ? 'Explain (required)' : 'Comment (optional)'} hint="Nothing is added to stock. This is kept with your name and the time.">
              <input id={`${uid}-rt`} value={reasonText} onChange={(e) => setReasonText(e.target.value)} className={fieldClass} required={needsComment(reason?.meta)} maxLength={300} autoComplete="off" />
            </Field>
          </div>
          <div className="flex gap-2"><button type="submit" className={dangerClass} disabled={busy || reason === null}>Close the return</button><button type="button" className={buttonClass} onClick={() => setClosing(false)}>Keep it open</button></div>
        </form>
      ) : null}

      {view.closed && has(view.closeReason) ? <p className="text-sm text-fg">Closed: {view.closeReason}{has(view.closeText) ? ` — ${view.closeText}` : ''}.</p> : null}

      <section className="space-y-2" aria-labelledby={`${uid}-h`}>
        <h3 id={`${uid}-h`} className="text-sm font-bold text-fg-strong">What was confirmed</h3>
        {view.confirmations.length === 0 ? <p className="text-sm text-fg-muted">Nothing has been confirmed yet.</p> : null}
        {view.confirmations.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-left text-xs">
              <caption className="sr-only">Goods confirmed, oldest first</caption>
              <thead className="text-fg-muted"><tr><th scope="col" className="py-1 pr-3">When</th><th scope="col" className="pr-3">Item</th><th scope="col" className="pr-3 text-right">Qty</th><th scope="col" className="pr-3">Condition</th><th scope="col">Done with it</th></tr></thead>
              <tbody>
                {view.confirmations.map((c) => (
                  <tr key={c.id} className="border-t border-line">
                    <td className="py-1.5 pr-3 whitespace-nowrap">{new Date(c.at).toLocaleString()}</td>
                    <td className="pr-3">{c.line}</td>
                    <td className="pr-3 text-right tabular-nums">{c.words}</td>
                    <td className="pr-3">{conditionLabel(c.condition)}</td>
                    <td>{dispositionLabel(c.disposition)} {c.stockAdded ? <Chip tone="green">Stock +{c.quantity}</Chip> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </div>
  );
}
