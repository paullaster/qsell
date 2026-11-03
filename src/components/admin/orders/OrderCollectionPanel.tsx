'use client';

import { useEffect, useId, useState } from 'react';
import { KeyRound } from 'lucide-react';
import {
  collectOrderAfterIdCheckAction,
  collectOrderWithCodeAction,
  collectionOfOrderAction,
  markReadyForCollectionAction,
  reissueCollectionCodeAction,
} from '@/server/domains/delivery/collection-actions';
import type { CollectionView } from '@/server/domains/delivery/collection';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { attempt, buttonClass, fieldClass, primaryClass } from '@/components/ui/screen-kit';

const STATUS_WORDS: Record<CollectionView['status'], string> = {
  waiting: 'Waiting to be prepared',
  ready: 'Ready, waiting for the customer',
  collected: 'Collected',
  locked: 'Code locked',
  cancelled: 'Cancelled',
};
const when = (iso: string): string => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Nairobi' });

/**
 * An order the customer comes to collect: where, and in what state, with what the person at the counter does: mark it ready, take
 * the code the customer shows, hand it over after an ID check when there is no code, or give a new code. Not drawn for an order that
 * is delivered, nor for someone who may not hand orders over.
 */
export function OrderCollectionPanel({ orderId, onChanged }: { orderId: string; onChanged: () => void }) {
  const uid = useId();
  const [view, setView] = useState<CollectionView | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  const [idSeen, setIdSeen] = useState('');
  const [reason, setReason] = useState('');
  const [fresh, setFresh] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void collectionOfOrderAction(orderId).then((r) => {
      if (cancelled) return;
      if (!r.ok || r.data === null) setHidden(true);
      else {
        setView(r.data);
        setHidden(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [orderId, version]);

  if (hidden || view === null) return null;

  const run = async (work: Promise<{ ok: true; data: unknown } | { ok: false; error: string }>, done: string, after?: () => void) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    setFresh(null);
    const result = await attempt(work);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      // A wrong code still counts a try: read the order again so the tries left are shown.
      setVersion((v) => v + 1);
      return;
    }
    setNotice(done);
    after?.();
    setVersion((v) => v + 1);
    onChanged();
  };

  const open = view.status === 'waiting' || view.status === 'ready' || view.status === 'locked';
  return (
    <section aria-label="Collection" className="space-y-3 rounded-xl border border-line bg-surface p-4">
      <h3 className="flex items-center gap-1.5 text-xs font-bold tracking-wider text-fg-strong uppercase">
        <KeyRound className="h-3.5 w-3.5 text-indigo-400" aria-hidden="true" />
        Collection
      </h3>
      <div className="space-y-0.5 text-sm">
        <p className="font-semibold text-fg-strong">{view.branch.name}</p>
        {view.branch.address === '' ? null : <p className="text-xs text-fg-muted">{view.branch.address}</p>}
        <p className="text-xs text-fg" role="status">
          {STATUS_WORDS[view.status]}
          {view.status === 'ready' && view.readyAt !== null ? ` since ${when(view.readyAt)}` : ''}
          {view.status === 'collected' && view.collectedAt !== null ? ` on ${when(view.collectedAt)}${view.collectedHow === 'id_check' ? ' after an ID check' : ' with the code'}` : ''}
          {open ? ` · ${String(view.attemptsLeft)} ${view.attemptsLeft === 1 ? 'try' : 'tries'} left on the code` : ''}
        </p>
      </div>

      {error === null ? null : (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      )}
      {notice === null ? null : (
        <p role="status" className="text-xs text-emerald-700">
          {notice}
        </p>
      )}
      {fresh === null ? null : (
        <p role="status" className="rounded-lg border border-line bg-surface-raised p-3 text-sm">
          New code for the customer: <span className="font-mono text-xl font-bold tracking-widest text-fg-strong">{fresh}</span>
        </p>
      )}

      {open ? (
        <div className="space-y-4">
          {view.status === 'waiting' ? (
            <button type="button" className={buttonClass} disabled={busy} onClick={() => void run(markReadyForCollectionAction(orderId), 'Marked ready for collection.')}>
              Mark ready for collection
            </button>
          ) : null}

          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              void run(collectOrderWithCodeAction({ orderId, code }), 'Handed over to the customer.', () => setCode(''));
            }}
          >
            <label htmlFor={`${uid}-code`} className="block text-xs font-semibold text-fg-muted">
              Code the customer shows
            </label>
            <div className="flex flex-wrap gap-2">
              <input
                id={`${uid}-code`}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                maxLength={12}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                disabled={view.status === 'locked'}
                className={`${fieldClass} w-40 font-mono tracking-widest uppercase`}
                placeholder="ABC-DEF"
              />
              <button type="submit" className={primaryClass} disabled={busy || view.status === 'locked' || code.trim() === ''}>
                Hand over
              </button>
            </div>
          </form>

          <details className="text-xs">
            <summary className="min-h-10 cursor-pointer py-2 font-semibold text-indigo-500">The customer has no code, or it is locked</summary>
            <div className="space-y-3 pt-2">
              <div>
                <label htmlFor={`${uid}-id`} className="block text-xs font-semibold text-fg-muted">
                  ID you saw
                </label>
                <input id={`${uid}-id`} value={idSeen} onChange={(e) => setIdSeen(e.target.value)} maxLength={120} autoComplete="off" className={fieldClass} placeholder="For example: National ID ending 4321" />
              </div>
              <div>
                <label htmlFor={`${uid}-why`} className="block text-xs font-semibold text-fg-muted">
                  Why (kept with the hand-over)
                </label>
                <input id={`${uid}-why`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} autoComplete="off" className={fieldClass} placeholder="For example: lost the phone with the code" />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <InlineConfirm
                  label="Hand over after an ID check"
                  action="Hand over after an ID check"
                  confirm="Yes, hand over"
                  busy={busy}
                  onConfirm={() => void run(collectOrderAfterIdCheckAction({ orderId, idSeen, reason }), 'Handed over after an ID check.', () => { setIdSeen(''); setReason(''); })}
                />
                <button type="button" className={buttonClass} disabled={busy} onClick={() => void run(reissueCollectionCodeAction({ orderId, reason }).then((r) => { if (r.ok) setFresh(r.data.code); return r; }), 'A new code was given. The old one no longer works.')}>
                  Give a new code
                </button>
              </div>
              <p className="text-fg-muted">Both need a reason. Handing over after an ID check, and giving a new code, are for people allowed to do them.</p>
            </div>
          </details>
        </div>
      ) : null}
    </section>
  );
}
