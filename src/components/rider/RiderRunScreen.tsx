'use client';

import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { finishRunAction, type myRunAction } from '@/server/domains/delivery/rider-app-actions';
import type { RiderStopView } from '@/server/domains/delivery/rider-runs';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { Chip, Message, type Notice } from '@/components/ui/screen-kit';
import { canFinishHere, hasFinishWaiting, pendingStops } from '@/lib/rider-queue';
import { putItem } from './door-queue';
import { OfflineBar } from './OfflineBar';
import { newTryKey } from './door-support';
import { StopDoor } from './StopDoor';
import { useDoorQueue } from './useDoorQueue';
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
  return <Run run={res.data} />;
}

function Run({ run }: { run: Extract<Awaited<ReturnType<typeof myRunAction>>, { ok: true }>['data'] }) {
  const { items } = useDoorQueue();
  const pending = pendingStops(items, run.riderId, run.id);
  const finishWaiting = hasFinishWaiting(items, run.riderId, run.id);
  const canFinish = !finishWaiting && (run.canFinish || canFinishHere({ status: run.status, stops: run.items }, pending));
  return (
    <div className="space-y-4">
      <OfflineBar riderId={run.riderId} />
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
            <Stop key={s.deliveryId} stop={s} runId={run.id} riderId={run.riderId} waiting={pending.has(s.deliveryId)} />
          ))}
        </ol>
      )}
      {canFinish ? <Finish runId={run.id} riderId={run.riderId} label={run.number} /> : null}
      {finishWaiting ? (
        <p role="status" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Finishing this run is saved on this phone and will be sent when you have signal.
        </p>
      ) : null}
    </div>
  );
}

function Finish({ runId, riderId, label }: { runId: string; riderId: string; label: string }) {
  const router = useRouter();
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  return (
    <section aria-label="Finish the run" className="space-y-3 rounded-xl border border-line bg-surface-raised p-4">
      <p className="text-sm text-fg">Every stop is done. Finish the run to hand it back to the shop.</p>
      <Message notice={notice} />
      <InlineConfirm
        label="Finish this run"
        action="Finish the run"
        confirm="Yes, finish it"
        busy={busy}
        onConfirm={async () => {
          setBusy(true);
          const keep = async (): Promise<void> => {
            const saved = await putItem({ id: newTryKey(), riderId, kind: 'finish', runId, deliveryId: null, label, payload: {}, photo: null, photoId: null, createdAt: new Date().toISOString(), state: 'waiting', message: null, tries: 0, nextAt: 0 });
            setBusy(false);
            if (!saved) setNotice({ kind: 'error', text: 'This phone could not save it to send later. Try again when you have signal.' });
          };
          if (!navigator.onLine) {
            await keep();
            return;
          }
          let r: Awaited<ReturnType<typeof finishRunAction>>;
          try {
            r = await finishRunAction(runId);
          } catch {
            await keep();
            return;
          }
          setBusy(false);
          if (!r.ok) setNotice({ kind: 'error', text: r.error });
          else router.refresh();
        }}
      />
    </section>
  );
}

function Stop({ stop, runId, riderId, waiting }: { stop: RiderStopView; runId: string; riderId: string; waiting: boolean }) {
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
      <StopDoor runId={runId} riderId={riderId} stop={stop} waiting={waiting} />
    </li>
  );
}
