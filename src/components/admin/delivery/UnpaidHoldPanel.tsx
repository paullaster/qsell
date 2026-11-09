'use client';

import { useEffect, useId, useState } from 'react';
import { setUnpaidHoldAction, unpaidHoldAction, type UnpaidHoldView } from '@/server/domains/stock/hold-actions';
import { Chip, LoadFailed, Message, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

/** How long a shop order that is to be paid at once holds its stock before it is given back. */
export function UnpaidHoldPanel() {
  const uid = useId();
  const [view, setView] = useState<UnpaidHoldView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void unpaidHoldAction().then((r) => {
      if (!live) return;
      if (r.ok) {
        setView(r.data);
        setText(String(r.data.minutes));
      } else setError(r.error);
    });
    return () => {
      live = false;
    };
  }, []);

  if (error !== null) return <LoadFailed error={error} />;
  if (view === null) return <p role="status" className="text-sm text-fg-muted">Loading…</p>;

  const minutes = Number(text);
  const valid = text.trim() !== '' && Number.isInteger(minutes) && minutes >= 0 && minutes <= 10080;
  const save = async (value: number) => {
    setBusy(true);
    setNotice(null);
    const result = await attempt(setUnpaidHoldAction({ minutes: value }));
    setBusy(false);
    if (!result.ok) {
      setNotice({ kind: 'error', text: result.error });
      return;
    }
    setView(result.data);
    setText(String(result.data.minutes));
    setNotice({ kind: 'ok', text: 'Saved. It applies to orders placed from now on.' });
  };

  return (
    <section className={`${cardClass} space-y-3`} aria-label="Unpaid orders">
      <h2 className="text-base font-semibold text-fg-strong">Unpaid orders</h2>
      <p className="text-sm text-fg-muted">
        A shop order that is to be paid at once (M-Pesa, card) holds its stock while the shopper pays. If it is not paid in this time the stock is given back and the order is marked failed, so an abandoned checkout cannot keep stock from other buyers.
      </p>
      <Message notice={notice} />
      <p className="text-xs text-fg-muted">
        In use now: {view.minutes === 0 ? <Chip tone="amber">Held until settled, no time limit</Chip> : <Chip tone="green">{`${String(view.minutes)} minutes`}</Chip>}
      </p>
      {view.canChange ? (
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor={`${uid}-minutes`} className="mb-1 block text-sm font-medium text-fg">Minutes (0 to 10080; 0 means no time limit)</label>
            <input id={`${uid}-minutes`} type="number" inputMode="numeric" min={0} max={10080} step={1} value={text} onChange={(e) => setText(e.target.value)} className={`${fieldClass} w-40`} />
          </div>
          <button type="button" className={primaryClass} disabled={busy || !valid || minutes === view.minutes} onClick={() => void save(minutes)}>Save</button>
          <button type="button" className={buttonClass} disabled={busy || view.minutes === view.defaultMinutes} onClick={() => void save(view.defaultMinutes)}>Use the standard {view.defaultMinutes} minutes</button>
        </div>
      ) : (
        <p className="text-xs text-fg-muted">You can look at this, but changing it needs the stock switch-over permission.</p>
      )}
    </section>
  );
}
