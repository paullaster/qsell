'use client';

import { use } from 'react';
import Link from 'next/link';
import type { myRunAction } from '@/server/domains/delivery/rider-app-actions';
import type { RiderStopView } from '@/server/domains/delivery/rider-runs';
import { Chip } from '@/components/ui/screen-kit';
import type { RunStatus } from '@/lib/dispatch-run';

const TONE: Record<RunStatus, 'green' | 'amber' | 'red' | 'sky' | 'gray'> = { planned: 'sky', started: 'amber', completed: 'green', cancelled: 'gray' };
const stopTone = (status: string): 'green' | 'red' | 'sky' => {
  if (status === 'delivered') return 'green';
  return status === 'failed_attempt' ? 'red' : 'sky';
};
const linkClass = 'inline-flex min-h-11 flex-1 items-center justify-center rounded-lg border border-line px-3 text-sm font-semibold text-fg-strong hover:bg-surface';

/** One run: its stops in the order to drive them, with what to carry and the buttons to call, chat and navigate. */
export function RiderRunScreen({ runPromise }: { runPromise: ReturnType<typeof myRunAction> }) {
  const res = use(runPromise);
  if (!res.ok) {
    return (
      <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
        {res.error}
      </p>
    );
  }
  const run = res.data;
  return (
    <div className="space-y-4">
      <Link href="/rider" className="inline-flex min-h-11 items-center text-sm font-semibold text-indigo-600 underline dark:text-indigo-400">
        ← My runs
      </Link>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-mono text-xl font-bold text-fg-strong">{run.number}</h1>
          <p className="text-sm text-fg-muted">
            {run.runDate} · from {run.branchName}
            {run.vehicle === null ? '' : ` · ${run.vehicle}`}
          </p>
        </div>
        <Chip tone={TONE[run.status]}>{run.statusWords}</Chip>
      </div>
      {run.notes === null ? null : <p className="rounded-xl border border-line bg-surface-raised p-3 text-sm">{run.notes}</p>}
      {run.status === 'planned' ? (
        <p role="status" className="rounded-xl border border-sky-300 bg-sky-50 p-3 text-sm text-sky-900">
          This run has not gone out yet. The stops may still change.
        </p>
      ) : null}
      {run.items.length === 0 ? (
        <p role="status" className="rounded-xl border border-line bg-surface-raised p-5 text-center text-sm text-fg-muted">
          No delivery is on this run yet.
        </p>
      ) : (
        <ol className="space-y-3" aria-label="Stops">
          {run.items.map((s) => (
            <Stop key={s.deliveryId} stop={s} />
          ))}
        </ol>
      )}
    </div>
  );
}

function Stop({ stop }: { stop: RiderStopView }) {
  return (
    <li className="space-y-3 rounded-xl border border-line bg-surface-raised p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-fg-muted">Stop {stop.sequence}</p>
          <p className="text-base font-bold text-fg-strong">{stop.receiver.name}</p>
          <p className="font-mono text-xs text-fg-muted">
            {stop.number} · order {stop.orderNumber}
          </p>
        </div>
        <Chip tone={stopTone(stop.status)}>{stop.statusWords}</Chip>
      </div>
      {stop.address.length > 0 ? <p className="break-words text-sm text-fg">{stop.address.join(', ')}</p> : null}
      {stop.instructions === null ? null : (
        <p className="rounded-lg bg-amber-50 p-2 text-sm text-amber-900">
          <span className="font-semibold">Note: </span>
          {stop.instructions}
        </p>
      )}
      {stop.items.length === 0 ? null : (
        <ul className="text-sm text-fg" aria-label="To hand over">
          {stop.items.map((i) => (
            <li key={i.name}>
              {i.quantity} × {i.name}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        {stop.links.call === null ? null : (
          <a href={stop.links.call} className={linkClass}>
            Call
          </a>
        )}
        {stop.links.chat === null ? null : (
          <a href={stop.links.chat} className={linkClass} target="_blank" rel="noreferrer">
            WhatsApp
          </a>
        )}
        {stop.links.navigate === null ? null : (
          <a href={stop.links.navigate} className={linkClass}>
            Navigate
          </a>
        )}
      </div>
    </li>
  );
}
