'use client';

import { use, useId, useState } from 'react';
import Link from 'next/link';
import { runStepAction, type runAction } from '@/server/domains/delivery/run-actions';
import type { RunView } from '@/server/domains/delivery/runs';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import type { Choice } from '@/lib/payment-options';
import { moveStop, type RunAction, type RunStatus } from '@/lib/dispatch-run';

type Loaded = Awaited<ReturnType<typeof runAction>>;

const TONE: Record<RunStatus, 'green' | 'amber' | 'red' | 'sky' | 'gray'> = { planned: 'sky', started: 'amber', completed: 'green', cancelled: 'gray' };
const DONE: Record<RunAction, string> = { start: 'The run is on the road. Every delivery on it has gone out.', complete: 'The run is closed.', cancel: 'The run is cancelled.' };
const stopTone = (status: string): 'green' | 'red' | 'sky' => {
  if (status === 'delivered') return 'green';
  return status === 'failed_attempt' ? 'red' : 'sky';
};
const money = (n: number): string => n.toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

export function RunDetailClient({ viewPromise }: { viewPromise: ReturnType<typeof runAction> }) {
  const res: Loaded = use(viewPromise);
  return res.ok ? <Screen initial={res.data} /> : <LoadFailed error={res.error} />;
}

function Screen({ initial }: { initial: RunView }) {
  const uid = useId();
  const [view, setView] = useState(initial);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [rider, setRider] = useState<Choice | null>(null);

  const run = async (body: Record<string, unknown>, done: string, after?: () => void) => {
    setBusy(true);
    setNotice(null);
    const result = await attempt(runStepAction({ runId: view.id, expectedVersion: view.version, ...body }));
    setBusy(false);
    if (!result.ok) {
      setNotice({ kind: 'error', text: result.error });
      return;
    }
    setView(result.data);
    setNotice({ kind: 'ok', text: done });
    after?.();
  };

  const ids = view.stops.map((s) => s.deliveryId);
  const can = (a: RunAction): boolean => view.actions.some((x) => x.action === a);
  const move = (id: string, direction: 'up' | 'down') => {
    const order = moveStop(ids, id, direction);
    if (order !== null) void run({ step: 'reorder', order }, 'The stops are in the new order.');
  };

  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader
        title={`Run ${view.number}`}
        intro={`${view.riderName}${view.vehicle === null ? '' : ` · ${view.vehicle}`} · ${view.runDate} · from ${view.branch.name}`}
        actions={<Chip tone={TONE[view.status]}>{view.statusWords}</Chip>}
      />
      <Link href="/admin/delivery/dispatch" className="inline-flex min-h-10 items-center text-xs font-semibold text-indigo-500 underline">
        ← Dispatch board
      </Link>
      <Message notice={notice} />

      {view.editable ? (
        <section aria-label="Rider" className={`${cardClass} flex flex-wrap items-end gap-3`}>
          <div className="min-w-0 flex-1 basis-64">
            <ChoicePicker label="Give the run to another rider" source="delivery-riders" choice={rider} onChoice={setRider} placeholder="Choose a rider" clearable />
          </div>
          <button type="button" className={buttonClass} disabled={busy || rider === null} onClick={() => void run({ step: 'assign_rider', riderId: rider?.id ?? '' }, 'The run is with the new rider.', () => setRider(null))}>
            Give the run
          </button>
          {view.riderId === null ? <p className="basis-full text-xs text-fg-muted">{view.riderName} is a name typed in: they do not see this run in the rider app.</p> : null}
        </section>
      ) : null}

      <section aria-label="Totals" className={`${cardClass} grid grid-cols-2 gap-3 sm:grid-cols-4`}>
        <div>
          <p className="text-xs text-fg-muted">Stops</p>
          <p className="text-lg font-bold text-fg-strong">{view.totals.stops}</p>
        </div>
        <div>
          <p className="text-xs text-fg-muted">Items</p>
          <p className="text-lg font-bold text-fg-strong">{view.totals.units}</p>
        </div>
        <div>
          <p className="text-xs text-fg-muted">Worth</p>
          <p className="text-lg font-bold text-fg-strong">KSh {money(view.totals.value)}</p>
        </div>
        <div>
          <p className="text-xs text-fg-muted">Weight</p>
          <p className="text-lg font-bold text-fg-strong">{view.totals.weightKg === null ? 'Not known' : `${String(view.totals.weightKg)} kg`}</p>
          {view.totals.weightKg !== null && view.totals.stopsWithoutWeight > 0 ? <p className="text-xs text-fg-muted">{view.totals.stopsWithoutWeight} without a weight</p> : null}
        </div>
      </section>

      <section aria-label="Stops" className={`${cardClass} space-y-3`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-fg-strong">Stops, in order</h3>
          {view.editable && view.stops.length > 1 ? (
            <button type="button" className={buttonClass} disabled={busy} onClick={() => void run({ step: 'arrange' }, 'The stops are in the suggested order: nearest next, from the branch.')}>
              Nearest first
            </button>
          ) : null}
        </div>
        {view.stops.length === 0 ? (
          <p role="status" className="text-sm text-fg-muted">
            No delivery is on this run yet. Put ready deliveries on it from the dispatch board.
          </p>
        ) : (
          <ol className="divide-y divide-line">
            {view.stops.map((s, i) => (
              <li key={s.deliveryId} className="grid grid-cols-1 gap-2 py-3 sm:grid-cols-[2rem_1fr_auto] sm:items-center sm:gap-4">
                <span className="text-sm font-bold text-fg-muted">{s.sequence}</span>
                <div className="min-w-0">
                  <Link href={`/admin/delivery/deliveries/${s.deliveryId}`} className="font-mono text-sm font-semibold text-indigo-600 hover:underline dark:text-indigo-400">
                    {s.deliveryNumber}
                  </Link>{' '}
                  <Chip tone={stopTone(s.status)}>{s.statusWords}</Chip>
                  <p className="text-sm text-fg-strong">{s.customerName}</p>
                  <p className="text-xs text-fg-muted">
                    Order {s.orderNumber} · {s.area === '' ? 'No area given' : s.area} · {s.units} {s.units === 1 ? 'item' : 'items'} · KSh {money(s.value)}
                  </p>
                </div>
                {view.editable ? (
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className={buttonClass} disabled={busy || i === 0} onClick={() => move(s.deliveryId, 'up')} aria-label={`Move ${s.deliveryNumber} up`}>
                      Up
                    </button>
                    <button type="button" className={buttonClass} disabled={busy || i === view.stops.length - 1} onClick={() => move(s.deliveryId, 'down')} aria-label={`Move ${s.deliveryNumber} down`}>
                      Down
                    </button>
                    <button type="button" className={buttonClass} disabled={busy} onClick={() => void run({ step: 'remove_stop', deliveryId: s.deliveryId }, `${s.deliveryNumber} is off the run.`)} aria-label={`Take ${s.deliveryNumber} off the run`}>
                      Take off
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>

      {view.actions.length > 0 ? (
        <section aria-label="Next" className={`${cardClass} space-y-3`}>
          <h3 className="text-sm font-bold text-fg-strong">Next</h3>
          <div className="flex flex-wrap gap-2">
            {can('start') ? (
              <button type="button" className={primaryClass} disabled={busy || view.stops.length === 0} onClick={() => void run({ step: 'start' }, DONE.start)}>
                Start the run
              </button>
            ) : null}
            {can('complete') ? (
              <button type="button" className={primaryClass} disabled={busy} onClick={() => void run({ step: 'complete' }, DONE.complete)}>
                Close the run
              </button>
            ) : null}
          </div>
          {can('start') ? <p className="text-xs text-fg-muted">Starting sends every delivery on the run out together. If one cannot go, none does, and you are told which.</p> : null}
          {can('complete') ? <p className="text-xs text-fg-muted">Record how each delivery went first (on its own screen). A run closes once none is still out.</p> : null}
          {can('cancel') ? (
            <div className="space-y-2 rounded-lg border border-line bg-surface p-3">
              <Field id={`${uid}-cr`} label="Why the run is being cancelled">
                <input id={`${uid}-cr`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className={fieldClass} autoComplete="off" />
              </Field>
              <InlineConfirm label="Cancel this run" action="Cancel the run" confirm="Yes, cancel it" busy={busy} onConfirm={() => void run({ step: 'cancel', reason }, DONE.cancel, () => setReason(''))} />
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
