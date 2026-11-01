'use client';

import { useEffect, useId, useState } from 'react';
import { Boxes } from 'lucide-react';
import { orderStockAction, resourceOrderStockAction, type OrderStockLine, type OrderStockView } from '@/server/domains/stock/order-stock-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { attempt, buttonClass, fieldClass, primaryClass } from '@/components/ui/screen-kit';
import type { Choice } from '@/lib/payment-options';

const STATE_WORDS: Record<string, string> = { held: 'Held', partly_consumed: 'Partly issued', consumed: 'Issued', released: 'Given back', expired: 'Ran out' };
const when = (iso: string): string => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Nairobi' });

/**
 * Where the order's stock is held, since when, and why that place; and, before it is picked, a way to take it from another place
 * with a reason. Without the new stock ledger nothing is held per place, and the panel says so.
 */
export function OrderStockPanel({ orderId, canMove }: { orderId: string; canMove: boolean }) {
  const uid = useId();
  const [view, setView] = useState<OrderStockView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [place, setPlace] = useState<Choice | null>(null);
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  // Read again after a move: bumping this asks the effect below to fetch afresh.
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void orderStockAction(orderId).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setView(result.data);
        setError(null);
      } else {
        setError(result.error);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [orderId, version]);

  const move = async (line: OrderStockLine) => {
    setBusy(true);
    setError(null);
    setDone(null);
    const res = await attempt(resourceOrderStockAction(orderId, line.productId, place?.id ?? '', why));
    setBusy(false);
    if (res.ok) {
      setDone(`The stock for ${line.productName} is now held at ${place?.label ?? 'the new place'}.`);
      setMoving(null);
      setPlace(null);
      setWhy('');
      setVersion((v) => v + 1);
    } else {
      setError(res.error);
    }
  };

  if (error !== null && view === null) {
    return error.includes('permission') ? null : (
      <section aria-label="Order stock" className="space-y-2 rounded-xl border border-line bg-surface p-4">
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      </section>
    );
  }
  return (
    <section aria-label="Order stock" className="space-y-3 rounded-xl border border-line bg-surface p-4">
      <h3 className="flex items-center gap-1.5 text-xs font-bold tracking-wider text-fg-strong uppercase">
        <Boxes className="h-3.5 w-3.5 text-indigo-400" aria-hidden="true" />
        Stock
      </h3>
      {error === null ? null : (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      )}
      {done === null ? null : (
        <p role="status" className="text-xs text-emerald-700">
          {done}
        </p>
      )}
      {view === null && error === null ? <p role="status" className="text-xs text-fg-muted">Loading the stock…</p> : null}
      {view !== null && !view.ledgerOn ? <p className="text-xs text-fg-muted">Where the stock for each line is held is recorded once the new stock ledger is switched on.</p> : null}
      {view?.ledgerOn === true ? (
        <ul className="space-y-3">
          {view.lines.map((line) => {
            const open = line.holds.filter((h) => h.state === 'held' || h.state === 'partly_consumed');
            return (
              <li key={line.productId} className="space-y-1.5" data-product={line.productId}>
                <p className="text-sm font-semibold break-words text-fg-strong">
                  {line.productName} <span className="font-normal text-fg-muted">× {line.ordered}</span>
                </p>
                {line.holds.length === 0 ? <p className="text-xs text-fg-muted">Nothing is held for this line.</p> : null}
                <ul className="space-y-1">
                  {line.holds.map((h) => (
                    <li key={h.id} className="rounded-lg border border-line px-3 py-2 text-xs text-fg" data-state={h.state}>
                      <span className="font-semibold">{STATE_WORDS[h.state] ?? h.state}</span> {h.quantity} at <span className="font-mono">{h.locationCode}</span> · {h.locationName}
                      <span className="block text-fg-muted">
                        Since <time dateTime={h.createdAt}>{when(h.createdAt)}</time>
                        {h.state === 'held' || h.state === 'partly_consumed' ? '' : `, ${(STATE_WORDS[h.state] ?? h.state).toLowerCase()} on ${when(h.stateChangedAt)}`}
                        {h.expiresAt === null || h.state !== 'held' ? '' : `, runs out ${when(h.expiresAt)}`}
                      </span>
                      {h.why === null ? null : <span className="block text-fg-muted">{h.why}</span>}
                      {h.reason === null ? null : <span className="block text-fg-muted">{h.reason}</span>}
                    </li>
                  ))}
                </ul>
                {canMove && view.may.resource && open.length > 0 && moving === line.productId ? (
                  <div className="space-y-2 rounded-lg border border-line p-3">
                    <ChoicePicker label={`Take ${line.productName} from`} source="stock-locations" {...(open[0] === undefined ? {} : { filters: { exclude: open[0].locationId } })} choice={place} onChoice={setPlace} placeholder="Another location" />
                    <div>
                      <label htmlFor={`${uid}-why-${line.productId}`} className="mb-1 block text-xs font-semibold text-fg">
                        Why
                      </label>
                      <input id={`${uid}-why-${line.productId}`} value={why} onChange={(e) => setWhy(e.target.value)} className={fieldClass} autoComplete="off" maxLength={300} />
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" className={primaryClass} disabled={busy} onClick={() => void move(line)}>
                        Move the stock
                      </button>
                      <button type="button" className={buttonClass} disabled={busy} onClick={() => setMoving(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
                {canMove && view.may.resource && open.length > 0 && moving !== line.productId ? (
                  <button type="button" className={buttonClass} onClick={() => { setMoving(line.productId); setDone(null); setError(null); }} aria-label={`Take ${line.productName} from another place`}>
                    Take it from another place
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
