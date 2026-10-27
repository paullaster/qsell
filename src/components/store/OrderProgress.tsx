'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, Clock } from 'lucide-react';
import { trackedOrderTimelineAction } from '@/server/domains/orders/timeline-actions';
import { stageTimeShort } from '@/lib/order-timeline-view';

/**
 * Where an order has got to, in a few plain stages with the time of each. It reads the order's own timeline, so it shows
 * what happened and when, not a guess. Only what the shop chooses to show a customer is here: no reasons, no staff.
 */
export function OrderProgress({ orderNumber, contact }: { orderNumber: string; contact: string }) {
  const [steps, setSteps] = useState<{ label: string; at: string }[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void trackedOrderTimelineAction({ orderNumber, contact }).then((result) => {
      if (cancelled) return;
      if (result.ok) setSteps(result.data);
      else setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [orderNumber, contact]);

  if (failed) return <p role="status" className="text-xs text-fg-muted">The progress of this order could not be loaded just now.</p>;
  if (steps === null) return <p role="status" className="text-xs text-fg-muted">Loading progress…</p>;
  if (steps.length === 0) return <p role="status" className="text-xs text-fg-muted">We will show each step here as it happens.</p>;
  return (
    <ol aria-label="Order progress" className="space-y-3">
      {steps.map((step, index) => (
        <li key={step.label} className="flex items-start gap-3">
          <span className="mt-0.5 text-emerald-600" aria-hidden="true">
            {index === steps.length - 1 ? <Clock className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
          </span>
          <span className="min-w-0 flex-1 text-sm font-semibold text-fg-strong">{step.label}</span>
          <time dateTime={step.at} className="shrink-0 font-mono text-xs text-fg-muted">{stageTimeShort(step.at)}</time>
        </li>
      ))}
    </ol>
  );
}
