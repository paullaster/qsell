import type { ReactNode } from 'react';
import { RescheduleForm } from './RescheduleForm';
import { CUSTOMER_STATUS_WORDS, HEADLINE, collectionWords, customerTone, trackingSteps, type TrackedOrder } from '@/lib/tracking-view';

const TONE: Record<ReturnType<typeof customerTone>, string> = {
  progress: 'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200',
  good: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  attention: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  ended: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
};

const stepClass = (s: { done: boolean; current: boolean }): string => {
  if (s.done) return 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200';
  if (s.current) return 'border-indigo-400 bg-indigo-50 font-semibold text-indigo-900 dark:bg-indigo-950 dark:text-indigo-200';
  return 'border-line text-fg-muted';
};

const when = (iso: string): string => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Nairobi' });
const qty = (n: number): string => String(Math.round(n * 1000) / 1000);

/**
 * What a customer sees of their order: how it stands, each delivery with the steps it has been through, what is in it, and what is
 * still to come. Used by the tracking page and by "Track my order", so they always say the same. Presentational only.
 */
export function TrackingView({ order, heading, token }: { order: TrackedOrder; heading?: ReactNode; token?: string }) {
  const collected = order.kind === 'collection' ? order.collection : null;
  const words = collected === null ? null : collectionWords(collected);
  return (
    <section aria-label="Your order" className="space-y-5">
      <header className="space-y-1">
        {heading}
        <p className="text-xs text-fg-muted">
          {order.storeName} · Order <span className="font-mono">{order.orderNumber}</span> · placed {when(order.placedAt)}
        </p>
        <h2 className="text-xl font-bold text-fg-strong" role="status">
          {words === null ? HEADLINE[order.state] : words.headline}
        </h2>
        {words === null ? null : <p className="text-sm text-fg">{words.detail}</p>}
      </header>

      {order.deliveries.length === 0 && order.kind === 'delivery' ? <p className="rounded-xl border border-line bg-surface-raised p-4 text-sm text-fg-muted">Nothing has been sent yet. We will tell you when your order leaves us.</p> : null}

      <ul className="space-y-4" aria-label="Deliveries">
        {order.deliveries.map((d) => (
          <li key={d.number} className="space-y-3 rounded-xl border border-line bg-surface-raised p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-mono text-sm font-semibold text-fg-strong">{d.number}</p>
              <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${TONE[customerTone(d.status)]}`}>{CUSTOMER_STATUS_WORDS[d.status]}</span>
            </div>
            <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label={`Steps of ${d.number}`}>
              {trackingSteps(d.status).map((s) => (
                <li key={s.label} aria-current={s.current ? 'step' : undefined} className={`rounded-lg border px-2 py-2 text-xs ${stepClass(s)}`}>
                  {s.done ? '✓ ' : ''}
                  {s.label}
                </li>
              ))}
            </ol>
            {d.items.length === 0 ? null : (
              <ul className="space-y-0.5 text-sm text-fg">
                {d.items.map((i) => (
                  <li key={i.name}>
                    {qty(i.quantity)} × {i.name}
                  </li>
                ))}
              </ul>
            )}
            {d.courier === null ? null : (
              <p className="text-xs text-fg-muted">
                With {d.courier.name}
                {d.courier.trackingNumber === null ? '' : `, their tracking number is ${d.courier.trackingNumber}`}.
              </p>
            )}
            {d.scheduledFor === null || d.status === 'delivered' ? null : (
              <p className="text-sm text-fg" role="note">
                We will try again on <strong>{d.scheduledFor}</strong>.
              </p>
            )}
            {d.canReschedule && token !== undefined ? <RescheduleForm token={token} deliveryNumber={d.number} /> : null}
            {d.handoverCode === null ? null : (
              <p className="rounded-lg border border-line bg-surface-sunken px-3 py-2 text-sm text-fg" role="note">
                Your delivery code is <strong className="font-mono text-base tracking-widest">{d.handoverCode}</strong>. Give it to the rider when your order arrives, and to no one else.
              </p>
            )}
            {d.status === 'delivered' && d.receivedBy !== null ? (
              <p className="text-xs text-fg-muted">
                Received by {d.receivedBy}
                {d.deliveredAt === null ? '' : ` on ${when(d.deliveredAt)}`}.
              </p>
            ) : null}
            {d.status === 'failed_attempt' ? <p className="text-xs text-fg">We could not deliver it this time. We will try again, or contact you.</p> : null}
          </li>
        ))}
      </ul>

      {order.waiting.length === 0 ? null : (
        <div className="space-y-1 rounded-xl border border-dashed border-line p-4">
          <h3 className="text-sm font-semibold text-fg-strong">Still to be sent</h3>
          <ul className="space-y-0.5 text-sm text-fg">
            {order.waiting.map((w) => (
              <li key={w.name}>
                {qty(w.quantity)} × {w.name}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
