'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { closeReturnAction, confirmReturnAction, type returnDetailAction } from '@/server/domains/returns/actions';
import { RETURN_STATUS } from './ReturnsClient';
import { Chip, Field, Message, PageHeader, buttonClass, cardClass, dangerClass, fieldClass, primaryClass, type Notice, attempt } from './ui';

type View = Extract<Awaited<ReturnType<typeof returnDetailAction>>, { ok: true }>['data'];

const CONDITION = { good: 'Good', damaged: 'Damaged', expired: 'Expired', wrong_item: 'Wrong item' } as const;
const DISPOSITION = { return_to_stock: 'Put back into stock', quarantine: 'Quarantine (not for sale)', scrap: 'Scrap / write off', return_to_supplier: 'Return to supplier' } as const;

interface Entry { qty: string; condition: keyof typeof CONDITION; disposition: keyof typeof DISPOSITION; note: string }

export function ReturnDetailClient({ view }: { view: View }) {
  const uid = useId();
  const router = useRouter();
  const open = !view.closed;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [entries, setEntries] = useState<Record<string, Entry>>(() =>
    Object.fromEntries(view.lines.map((l) => [l.id, { qty: '', condition: 'good', disposition: view.suggested, note: '' }])),
  );
  const [closing, setClosing] = useState(false);
  const [reason, setReason] = useState({ code: '', text: '' });
  const set = (id: string, patch: Partial<Entry>) => setEntries((e) => ({ ...e, [id]: { ...e[id]!, ...patch } }));

  const confirm = async (e: React.FormEvent) => {
    e.preventDefault();
    const items = view.lines
      .filter((l) => Number(entries[l.id]!.qty) > 0)
      .map((l) => ({ lineId: l.id, quantity: Number(entries[l.id]!.qty), condition: entries[l.id]!.condition, disposition: entries[l.id]!.disposition, note: entries[l.id]!.note || undefined }));
    setBusy(true);
    setNotice(null);
    const res = await attempt(confirmReturnAction(view.id, items));
    setBusy(false);
    if (!res.ok) return setNotice({ kind: 'error', text: res.error });
    setNotice({ kind: 'ok', text: res.data.stockAdded > 0 ? `Confirmed. ${res.data.stockAdded} ${res.data.stockAdded === 1 ? 'unit' : 'units'} added to stock.` : 'Confirmed. Nothing was added to stock.' });
    setEntries(Object.fromEntries(view.lines.map((l) => [l.id, { qty: '', condition: 'good', disposition: view.suggested, note: '' }])));
    router.refresh();
  };
  const close = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const res = await attempt(closeReturnAction(view.id, { code: reason.code, text: reason.text.trim() || undefined }));
    setBusy(false);
    if (!res.ok) return setNotice({ kind: 'error', text: res.error });
    setNotice({ kind: 'ok', text: 'Closed. Nothing more is expected.' });
    setClosing(false);
    router.refresh();
  };

  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader
        title={`Return ${view.number}`}
        intro={<span className="flex flex-wrap items-center gap-2"><Chip tone={RETURN_STATUS[view.status]?.tone ?? 'gray'}>{RETURN_STATUS[view.status]?.label ?? view.status}</Chip><span>Credit note {view.creditNoteNo} · order {view.order}</span></span>}
        actions={<Link href="/admin/finance/receivables/returns" className={buttonClass}>All returns</Link>}
      />
      <Message notice={notice} />

      <form onSubmit={confirm} className="space-y-3" aria-label="Confirm goods that arrived">
        {view.lines.map((l) => {
          const left = l.expected - l.received;
          const en = entries[l.id]!;
          return (
            <div key={l.id} className={`${cardClass} space-y-3`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-bold text-fg-strong">{l.description}</p>
                <p className="text-xs text-fg-muted">{l.received} of {l.expected} received{l.unitCost ? ` · cost ${Number(l.unitCost).toFixed(2)} each` : ''}</p>
              </div>
              {open && view.can.confirm && left > 0 ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                  <Field id={`${uid}-q-${l.id}`} label={`How many arrived (up to ${left})`}>
                    <input id={`${uid}-q-${l.id}`} value={en.qty} onChange={(e) => set(l.id, { qty: e.target.value })} className={fieldClass} inputMode="numeric" placeholder="0" autoComplete="off" />
                  </Field>
                  <Field id={`${uid}-c-${l.id}`} label="Condition">
                    <select id={`${uid}-c-${l.id}`} value={en.condition} onChange={(e) => set(l.id, { condition: e.target.value as Entry['condition'] })} className={fieldClass}>
                      {Object.entries(CONDITION).map(([v, t]) => <option key={v} value={v}>{t}</option>)}
                    </select>
                  </Field>
                  <Field id={`${uid}-d-${l.id}`} label="What was done with it">
                    <select id={`${uid}-d-${l.id}`} value={en.disposition} onChange={(e) => set(l.id, { disposition: e.target.value as Entry['disposition'] })} className={fieldClass}>
                      {Object.entries(DISPOSITION).map(([v, t]) => <option key={v} value={v}>{t}</option>)}
                    </select>
                  </Field>
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
            <button type="submit" className={primaryClass} disabled={busy || view.lines.every((l) => !(Number(entries[l.id]!.qty) > 0))}>Confirm what arrived</button>
            {view.can.reject ? <button type="button" className={dangerClass} disabled={busy} onClick={() => setClosing((v) => !v)} aria-expanded={closing}>The rest is not coming</button> : null}
          </div>
        ) : null}
        {open && !view.can.confirm ? <p className="text-sm text-fg-muted">You may view this return, but confirming goods needs another permission.</p> : null}
      </form>

      {closing ? (
        <form onSubmit={close} className={`${cardClass} space-y-3`} aria-label="Close this return">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field id={`${uid}-r`} label="Reason" hint="Nothing is added to stock. This is kept with your name and the time.">
              <select id={`${uid}-r`} value={reason.code} onChange={(e) => setReason({ ...reason, code: e.target.value })} className={fieldClass} required>
                <option value="">Choose a reason…</option>
                {view.reasons.map((r) => <option key={r.code} value={r.code}>{r.description}</option>)}
              </select>
            </Field>
            <Field id={`${uid}-rt`} label={view.reasons.find((r) => r.code === reason.code)?.requiresComment ? 'Explain (required)' : 'Comment (optional)'}>
              <input id={`${uid}-rt`} value={reason.text} onChange={(e) => setReason({ ...reason, text: e.target.value })} className={fieldClass} required={view.reasons.find((r) => r.code === reason.code)?.requiresComment ?? false} maxLength={300} autoComplete="off" />
            </Field>
          </div>
          <div className="flex gap-2"><button type="submit" className={dangerClass} disabled={busy || !reason.code}>Close the return</button><button type="button" className={buttonClass} onClick={() => setClosing(false)}>Keep it open</button></div>
        </form>
      ) : null}

      {view.closed && view.closeReason ? <p className="text-sm text-fg">Closed: {view.closeReason}{view.closeText ? ` — ${view.closeText}` : ''}.</p> : null}

      <section className="space-y-2" aria-labelledby={`${uid}-h`}>
        <h3 id={`${uid}-h`} className="text-sm font-bold text-fg-strong">What was confirmed</h3>
        {view.confirmations.length === 0 ? <p className="text-sm text-fg-muted">Nothing has been confirmed yet.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-left text-xs">
              <caption className="sr-only">Goods confirmed, oldest first</caption>
              <thead className="text-fg-muted"><tr><th scope="col" className="py-1 pr-3">When</th><th scope="col" className="pr-3">Item</th><th scope="col" className="pr-3 text-right">Qty</th><th scope="col" className="pr-3">Condition</th><th scope="col">Done with it</th></tr></thead>
              <tbody>
                {view.confirmations.map((c) => (
                  <tr key={c.id} className="border-t border-line">
                    <td className="py-1.5 pr-3 whitespace-nowrap">{new Date(c.at).toLocaleString()}</td>
                    <td className="pr-3">{c.line}</td>
                    <td className="pr-3 text-right tabular-nums">{c.quantity}</td>
                    <td className="pr-3">{CONDITION[c.condition]}</td>
                    <td>{DISPOSITION[c.disposition]} {c.stockAdded ? <Chip tone="green">Stock +{c.quantity}</Chip> : null}</td>
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
