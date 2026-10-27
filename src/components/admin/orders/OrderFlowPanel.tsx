'use client';

import { useEffect, useState } from 'react';
import { Activity } from 'lucide-react';
import { orderFlowAction } from '@/server/domains/orders/timeline-actions';
import type { OrderFlow } from '@/server/domains/orders/timeline-read';
import { reasonWords, stageTime } from '@/lib/order-timeline-view';

/**
 * How orders are flowing over the last week: how many checkouts were started, refused and placed, how many orders reached each
 * stage, why things failed, and which orders have sat in a stage too long. For people who may see order timelines; for everyone
 * else it shows nothing. It reads the same events as each order's timeline, so the numbers and the timelines agree.
 */
export function OrderFlowPanel() {
  const [flow, setFlow] = useState<OrderFlow | null>(null);
  const [allowed, setAllowed] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void orderFlowAction(7).then((result) => {
      if (cancelled) return;
      if (result.ok) setFlow(result.data);
      else setAllowed(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!allowed || flow === null) return null;
  const { checkouts } = flow;
  return (
    <details className="rounded-xl border border-line bg-surface p-4 text-sm" aria-label="Order flow">
      <summary className="flex min-h-10 cursor-pointer items-center gap-2 font-semibold text-fg-strong">
        <Activity className="h-4 w-4 text-indigo-400" aria-hidden="true" />
        Order flow, last {flow.days} days
        {flow.stuck.length > 0 ? <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700">{flow.stuck.length} stuck</span> : null}
        {flow.unrecorded > 0 ? <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-700">{flow.unrecorded} unrecorded</span> : null}
      </summary>
      <div className="mt-3 grid gap-4 md:grid-cols-2">
        <section aria-label="Checkouts" className="space-y-1">
          <h3 className="text-xs font-bold tracking-wider text-fg-muted uppercase">Checkouts</h3>
          <p>
            <strong>{checkouts.started + checkouts.refused + checkouts.placed + checkouts.abandoned}</strong> started ·{' '}
            <strong>{checkouts.placed}</strong> became orders · <strong>{checkouts.refused}</strong> refused
          </p>
          {flow.refusals.length > 0 ? (
            <ul className="text-xs text-fg-muted">
              {flow.refusals.map((r) => (
                <li key={r.reason}>
                  {r.count} × {reasonWords(r.reason)}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
        <section aria-label="Orders by stage" className="space-y-1">
          <h3 className="text-xs font-bold tracking-wider text-fg-muted uppercase">Orders that reached</h3>
          <ul className="text-xs text-fg-muted">
            {flow.milestones.map((m) => (
              <li key={m.stage}>
                <strong className="text-fg">{m.count}</strong> {m.label.toLowerCase()}
              </li>
            ))}
          </ul>
        </section>
        {flow.failures.length > 0 ? (
          <section aria-label="Failures" className="space-y-1">
            <h3 className="text-xs font-bold tracking-wider text-fg-muted uppercase">What failed</h3>
            <ul className="text-xs text-fg-muted">
              {flow.failures.map((f) => (
                <li key={`${f.stage}-${f.reason}`}>
                  {f.count} × {f.label.toLowerCase()}: {reasonWords(f.reason)}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {flow.stuck.length > 0 ? (
          <section aria-label="Stuck orders" className="space-y-1">
            <h3 className="text-xs font-bold tracking-wider text-fg-muted uppercase">Stuck</h3>
            <ul className="text-xs text-fg-muted">
              {flow.stuck.map((s) => (
                <li key={s.orderId}>
                  <span className="font-mono text-fg">{s.orderNumber}</span>: {s.label.toLowerCase()} since {stageTime(s.since)}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </details>
  );
}
