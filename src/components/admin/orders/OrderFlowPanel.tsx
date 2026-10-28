'use client';

import { useEffect, useState } from 'react';
import { Activity } from 'lucide-react';
import { orderFlowAction } from '@/server/domains/orders/timeline-actions';
import type { OrderFlow } from '@/server/domains/orders/timeline-read';
import { acknowledgeLateOrderAction, lateOrdersAction } from '@/server/domains/orders/sla-actions';
import type { BreachView } from '@/server/domains/orders/sla-service';
import { durationWords } from '@/lib/order-sla';
import { ORDER_STAGES, isOrderStage } from '@/lib/order-stages';
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
      <LateOrders />
    </details>
  );
}

/** Orders that waited longer than their stage's target, oldest first; a person can say they are on it. */
function LateOrders() {
  const [rows, setRows] = useState<BreachView[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = (cursor: string | null, replace: boolean) => {
    void lateOrdersAction(cursor ?? undefined).then((result) => {
      setLoaded(true);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setRows((all) => (replace ? result.data.rows : [...all, ...result.data.rows]));
      setNext(result.data.nextCursor);
    });
  };
  useEffect(() => {
    load(null, true);
  }, []);

  const acknowledge = (id: string) => {
    setBusyId(id);
    void acknowledgeLateOrderAction(id, '').then((result) => {
      setBusyId(null);
      if (result.ok) load(null, true);
      else setError(result.error);
    });
  };

  if (loaded && rows.length === 0 && error === null) return null;
  return (
    <section aria-label="Late orders" className="mt-4 space-y-2 border-t border-line pt-3">
      <h3 className="text-xs font-bold tracking-wider text-fg-muted uppercase">Late orders</h3>
      {error === null ? null : (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      )}
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-col gap-2 rounded-lg border border-line p-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-fg-muted">
              <span className="font-mono text-fg">{r.orderNumber}</span>: {(isOrderStage(r.stage) ? ORDER_STAGES[r.stage].label : r.stage).toLowerCase()} for {durationWords(r.waitedMinutes)} (target {durationWords(r.targetMinutes)})
              {r.escalatedAt === null ? null : <span className="ml-2 rounded-full bg-red-500/15 px-2 py-0.5 font-medium text-red-700">escalated</span>}
              {r.acknowledgedAt === null ? null : <span className="ml-2 rounded-full bg-emerald-500/15 px-2 py-0.5 font-medium text-emerald-700">someone is on it</span>}
            </p>
            {r.acknowledgedAt === null ? (
              <button type="button" disabled={busyId === r.id} onClick={() => acknowledge(r.id)} className="min-h-10 rounded-lg border border-line px-3 text-xs font-semibold text-fg-strong">
                {busyId === r.id ? 'Saving…' : 'I am on it'}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {next === null ? null : (
        <button type="button" onClick={() => load(next, false)} className="min-h-10 rounded-lg border border-line px-3 text-xs font-semibold text-fg-strong">
          Show more
        </button>
      )}
    </section>
  );
}
