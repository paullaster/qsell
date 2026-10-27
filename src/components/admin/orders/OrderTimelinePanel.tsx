'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Circle, Clock, XCircle } from 'lucide-react';
import { orderTimelineAction } from '@/server/domains/orders/timeline-actions';
import type { OrderTimelineView } from '@/server/domains/orders/timeline-read';
import { durationWords, outcomeTone, reasonWords, stageTime } from '@/lib/order-timeline-view';

const toneClass = { good: 'text-emerald-600', bad: 'text-red-600', neutral: 'text-fg-muted' } as const;
const toneIcon = { good: CheckCircle2, bad: XCircle, neutral: Circle } as const;

/**
 * Every stage the order went through, with its time, how long it took from the one before, and (for those allowed to see it) who
 * did it, from where and why. Failures show their reason. A history rebuilt from an older order says it is approximate.
 */
export function OrderTimelinePanel({ orderId }: { orderId: string }) {
  const [view, setView] = useState<OrderTimelineView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void orderTimelineAction(orderId).then((result) => {
      if (cancelled) return;
      if (result.ok) setView(result.data);
      else setError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  return (
    <section aria-label="Order timeline" className="space-y-3 rounded-xl border border-line bg-surface p-4">
      <h3 className="flex items-center gap-1.5 text-xs font-bold tracking-wider text-fg-strong uppercase">
        <Clock className="h-3.5 w-3.5 text-indigo-400" aria-hidden="true" />
        Timeline
      </h3>
      {error !== null ? <p role="alert" className="text-xs text-red-700">{error}</p> : null}
      {error === null && view === null ? <p role="status" className="text-xs text-fg-muted">Loading the timeline…</p> : null}
      {view !== null && view.events.length === 0 ? <p className="text-xs text-fg-muted">No stages are recorded for this order yet.</p> : null}
      {view !== null && view.events.length > 0 ? (
        <ol className="space-y-3">
          {view.events.map((event) => {
            const tone = outcomeTone(event.outcome);
            const Icon = toneIcon[tone];
            const gap = durationWords(event.sincePreviousMs);
            const why = event.detail === undefined ? '' : [reasonWords(event.detail.reasonCode), event.detail.message ?? ''].filter((part) => part !== '').join(': ');
            return (
              <li key={event.sequence} className="flex items-start gap-3" data-stage={event.stage} data-outcome={event.outcome}>
                <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${toneClass[tone]}`} aria-hidden="true" />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold text-fg-strong">
                    <span>{event.label}</span>
                    {event.outcome === 'failed' ? <span className="text-xs font-medium text-red-700">failed</span> : null}
                    {event.approximate ? (
                      <span className="inline-flex items-center gap-1 text-xs font-normal text-amber-700" title="Rebuilt from what the order already held; the time may be approximate.">
                        <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                        approximate
                      </span>
                    ) : null}
                  </p>
                  <p className="text-xs text-fg-muted">
                    <time dateTime={event.at} className="font-mono">{stageTime(event.at)}</time>
                    {gap === '' ? '' : ` · ${gap} after the stage before`}
                  </p>
                  {why === '' ? null : <p className={`text-xs ${tone === 'bad' ? 'text-red-700' : 'text-fg-muted'}`}>{why}</p>}
                  {event.detail === undefined ? null : (
                    <p className="text-[11px] text-fg-subtle">
                      {event.detail.source}
                      {event.detail.actorId === null ? '' : ` · ${event.detail.actorType} ${event.detail.actorId}`}
                      {event.detail.attemptNo === null ? '' : ` · attempt ${String(event.detail.attemptNo)}`}
                      {event.detail.refId === null ? '' : ` · ${event.detail.refType ?? 'ref'} ${event.detail.refId.slice(0, 8)}`}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}
      {view !== null && !view.detailed ? <p className="text-[11px] text-fg-subtle">Who did each step, and why, is shown to people with the “see an order’s stage timeline” permission.</p> : null}
    </section>
  );
}
