'use client';

import { useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { Truck } from 'lucide-react';
import { createDeliveryAction, orderDeliveriesAction } from '@/server/domains/delivery/document-actions';
import { Chip, attempt, fieldClass, primaryClass } from '@/components/ui/screen-kit';
import { ORDER_STATE_WORDS, type DeliveryStatus, type OrderDeliveryState } from '@/lib/delivery-document';

type Loaded = Extract<Awaited<ReturnType<typeof orderDeliveriesAction>>, { ok: true }>['data'];

const STATE_TONE: Record<OrderDeliveryState, 'green' | 'amber' | 'red' | 'sky' | 'gray'> = { not_started: 'gray', in_progress: 'sky', partly_delivered: 'amber', delivered: 'green', exceptions: 'red' };
const DELIVERY_TONE: Partial<Record<DeliveryStatus, 'green' | 'amber' | 'red' | 'sky' | 'gray'>> = { delivered: 'green', failed_attempt: 'red', returned: 'red', cancelled: 'gray', ready: 'amber', out_for_delivery: 'amber' };

/**
 * An order's deliveries: where the order stands (worked out from them), what is left of each product, the deliveries so far, and
 * a way to make another from what is left. Not drawn for an order that is not delivered by a delivery document (collected orders
 * have their own panel), nor for someone who may not see deliveries.
 */
export function OrderDeliveriesPanel({ orderId, onChanged }: { orderId: string; onChanged: () => void }) {
  const uid = useId();
  const [data, setData] = useState<Loaded | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ id: string; number: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState<Record<string, string>>({});
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void orderDeliveriesAction(orderId).then((r) => {
      if (cancelled) return;
      if (!r.ok || !r.data.eligible.ok) setHidden(true);
      else {
        setData(r.data);
        setHidden(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [orderId, version]);

  if (hidden || data === null) return null;
  const open = data.lines.filter((l) => l.open > 0);
  const quantityFor = (line: Loaded['lines'][number]): string => asked[line.productId] ?? String(line.open);

  const make = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const lines = open.map((l) => ({ productId: l.productId, quantity: Number(quantityFor(l)) })).filter((l) => l.quantity > 0);
    const result = await attempt(createDeliveryAction({ orderId, lines }));
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setNotice(result.data);
    setAsked({});
    setVersion((v) => v + 1);
    onChanged();
  };

  return (
    <section aria-label="Deliveries" className="space-y-3 rounded-xl border border-line bg-surface p-4">
      <h3 className="flex flex-wrap items-center gap-2 text-xs font-bold tracking-wider text-fg-strong uppercase">
        <Truck className="h-3.5 w-3.5 text-indigo-400" aria-hidden="true" />
        Deliveries
        <Chip tone={STATE_TONE[data.state]}>{ORDER_STATE_WORDS[data.state]}</Chip>
      </h3>

      <ul className="divide-y divide-line text-xs" aria-label="What is left to deliver">
        {data.lines.map((l) => (
          <li key={l.productId} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1.5">
            <span className="min-w-0 break-words font-semibold text-fg-strong">{l.productName}</span>
            <span className="text-fg-muted">
              ordered {String(l.ordered)} · delivered {String(l.delivered)} · {l.open > 0 ? `${String(l.open)} not on a delivery yet` : 'all on deliveries'}
            </span>
          </li>
        ))}
      </ul>

      {data.deliveries.length === 0 ? null : (
        <ul className="space-y-1" aria-label="The deliveries of this order">
          {data.deliveries.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-2 text-xs">
              <Link href={`/admin/delivery/deliveries/${d.id}`} className="min-h-10 py-2 font-mono font-semibold text-indigo-600 hover:underline dark:text-indigo-400">
                {d.number}
              </Link>
              <Chip tone={DELIVERY_TONE[d.status] ?? 'sky'}>{d.statusWords}</Chip>
              <span className="text-fg-muted">{d.lineCount} {d.lineCount === 1 ? 'product' : 'products'}</span>
            </li>
          ))}
        </ul>
      )}

      {error === null ? null : (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      )}
      {notice === null ? null : (
        <p role="status" className="text-xs text-emerald-700">
          Delivery <Link href={`/admin/delivery/deliveries/${notice.id}`} className="font-mono font-semibold underline">{notice.number}</Link> is made.
        </p>
      )}

      {data.canFulfil && open.length > 0 ? (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-fg-muted">Make a delivery of</p>
          <ul className="space-y-2">
            {open.map((l) => (
              <li key={l.productId} className="flex flex-wrap items-center justify-between gap-2">
                <label htmlFor={`${uid}-${l.productId}`} className="min-w-0 flex-1 text-xs break-words text-fg">
                  {l.productName} (up to {String(l.open)})
                </label>
                <input
                  id={`${uid}-${l.productId}`}
                  inputMode="decimal"
                  value={quantityFor(l)}
                  onChange={(e) => setAsked({ ...asked, [l.productId]: e.target.value })}
                  className={`${fieldClass} w-24 font-mono`}
                  autoComplete="off"
                />
              </li>
            ))}
          </ul>
          <button type="button" className={primaryClass} disabled={busy} onClick={() => void make()}>
            Make the delivery
          </button>
          <p className="text-xs text-fg-muted">Put nothing (0) for what is not ready; it stays on the order for another delivery.</p>
        </div>
      ) : null}
    </section>
  );
}
