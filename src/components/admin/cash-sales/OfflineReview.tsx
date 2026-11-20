'use client';

import { useCallback, useEffect, useState } from 'react';
import { acknowledgeOfflineSaleAction, discardOfflineSaleAction, offlineReviewAction, retryParkedOfflineSaleAction, type OfflineReviewScreen } from '@/server/domains/selling/offline/offline-actions';
import { flagWords } from '@/server/domains/selling/offline/offline-rules';
import { Chip, buttonClass, cardClass, fieldClass, primaryClass } from '@/components/ui/screen-kit';

const money = (amount: number): string => `KES ${amount.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const STATUS: Record<string, { label: string; tone: 'amber' | 'red' | 'sky' }> = { needs_review: { label: 'Needs a look', tone: 'sky' }, parked: { label: 'Not made yet', tone: 'amber' }, rejected: { label: 'Refused', tone: 'red' } };

/** Offline sales that need a person: accepted with a difference, kept because the stock was not there, or refused. A supervisor looks, tries again, or gives one up with a reason. */
export function OfflineReview() {
  const [data, setData] = useState<OfflineReviewScreen | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [giving, setGiving] = useState<string | null>(null);
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await offlineReviewAction();
    if (r.ok) setData(r.data);
    else setError(r.error);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount: state is set when the answer arrives
    void load();
  }, [load]);
  if (error !== null) return <p role="alert" className="text-sm text-red-700">{error}</p>;
  if (data === null || data.rows.length === 0) return null;
  const act = async (call: () => Promise<{ ok: boolean; error?: string }>, done: string) => {
    setBusy(true);
    setNotice(null);
    const r = await call();
    setBusy(false);
    if (r.ok) {
      setNotice(done);
      setGiving(null);
      setWhy('');
      await load();
    } else setNotice(r.error ?? 'That could not be done.');
  };
  return (
    <section className="space-y-2 print:hidden" aria-label="Offline sales to look at" data-testid="offline-review">
      <h2 className="text-sm font-bold tracking-wider text-fg-subtle uppercase">Offline sales to look at</h2>
      {notice === null ? null : <p role="status" className="text-sm text-fg-muted" data-testid="offline-review-notice">{notice}</p>}
      <ul className="space-y-2">
        {data.rows.map((r) => (
          <li key={r.id} className={`${cardClass} space-y-2`} data-testid="offline-review-row">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-semibold break-words text-fg-strong">{r.deviceRef} · {money(r.total)}{r.orderNumber === null ? '' : ` · sale ${r.orderNumber}`}</p>
              <Chip tone={STATUS[r.status]?.tone ?? 'gray'}>{STATUS[r.status]?.label ?? r.status}</Chip>
            </div>
            <p className="text-sm text-fg-muted">{r.cashier} · rung up {new Date(r.deviceTime).toLocaleString()} · received {new Date(r.receivedAt).toLocaleString()}</p>
            {r.reason === null ? null : <p className="text-sm text-fg-strong">{r.reason}</p>}
            {r.flags.length === 0 ? null : <ul className="text-sm text-amber-700">{r.flags.map((f) => <li key={f}>{flagWords(f)}</li>)}</ul>}
            {data.canSupervise && giving === r.id ? (
              <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void act(async () => await discardOfflineSaleAction(r.id, why), 'The sale was given up, with your reason kept.'); }}>
                <label className="text-sm text-fg-muted">Why it is given up<input className={`${fieldClass} mt-1 block w-72 max-w-full`} value={why} maxLength={200} onChange={(e) => setWhy(e.target.value)} /></label>
                <button type="submit" className={primaryClass} disabled={busy || why.trim().length < 3}>Give it up</button>
                <button type="button" className={buttonClass} onClick={() => setGiving(null)} disabled={busy}>Cancel</button>
              </form>
            ) : null}
            {data.canSupervise && giving !== r.id ? (
              <div className="flex flex-wrap gap-2">
                {r.status === 'needs_review' ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void act(async () => await acknowledgeOfflineSaleAction(r.id), 'Marked as looked at.')}>Looked at</button> : null}
                {r.status === 'parked' ? <button type="button" className={primaryClass} disabled={busy} onClick={() => void act(async () => await retryParkedOfflineSaleAction(r.id), 'Tried again: see the list.')}>Try again</button> : null}
                {r.status === 'parked' || r.status === 'rejected' ? <button type="button" className={buttonClass} disabled={busy} onClick={() => { setGiving(r.id); setNotice(null); }}>Give up</button> : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
