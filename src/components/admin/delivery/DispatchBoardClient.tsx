'use client';

import { use, useId, useState } from 'react';
import Link from 'next/link';
import { courierNewsAction, createRunAction, dispatchBoardAction, runStepAction } from '@/server/domains/delivery/run-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import type { Choice } from '@/lib/payment-options';
import { SLA_WORDS, windowWords } from '@/lib/delivery-sla';

const PROMISE_TONE = { on_track: 'sky', at_risk: 'amber', late: 'red', met: 'green', missed: 'red' } as const;

type Loaded = Awaited<ReturnType<typeof dispatchBoardAction>>;
type Board = Extract<Loaded, { ok: true }>['data'];

const money = (n: number): string => n.toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

export function DispatchBoardClient({ firstLoad }: { firstLoad: ReturnType<typeof dispatchBoardAction> }) {
  const res: Loaded = use(firstLoad);
  return res.ok ? <Board initial={res.data} /> : <LoadFailed error={res.error} />;
}

/**
 * The dispatch board: what is ready to go and on no run, the runs still to do, and the parcels out with couriers. A person plans a
 * run, picks it, and puts ready deliveries on it; the server checks that each is ready, from the run's branch, and on no other run.
 */
function Board({ initial }: { initial: Board }) {
  const uid = useId();
  const [board, setBoard] = useState(initial);
  const [branch, setBranch] = useState<Choice | null>(null);
  const [target, setTarget] = useState<Choice | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [rider, setRider] = useState('');
  const [riderChoice, setRiderChoice] = useState<Choice | null>(null);
  const [vehicle, setVehicle] = useState('');
  const [day, setDay] = useState('');
  const [runBranch, setRunBranch] = useState<Choice | null>(null);
  const [news, setNews] = useState<Record<string, { state: Choice | null; note: string; receivedBy: string; tracking: string }>>({});

  const reload = async (b: Choice | null) => {
    const r = await attempt(dispatchBoardAction({ branchId: b?.id ?? '' }));
    if (r.ok) setBoard(r.data);
    else setNotice({ kind: 'error', text: r.error });
  };

  const act = async <T,>(work: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, done: (data: T) => string) => {
    setBusy(true);
    setNotice(null);
    const r = await attempt(work());
    if (!r.ok) {
      setBusy(false);
      setNotice({ kind: 'error', text: r.error });
      return;
    }
    await reload(branch);
    setBusy(false);
    setNotice({ kind: 'ok', text: done(r.data) });
  };

  return (
    <div className="max-w-6xl space-y-6">
      <PageHeader title="Dispatch board" intro="What is ready to go, the runs being planned, and the parcels out with couriers." actions={<Link href="/admin/delivery/runs" className={buttonClass}>All runs</Link>} />
      <Message notice={notice} />
      <div className="max-w-sm">
        <ChoicePicker
          label="Branch"
          source="delivery-branches"
          choice={branch}
          onChoice={(c) => {
            setBranch(c);
            void reload(c);
          }}
          placeholder="All branches"
          clearable
        />
      </div>

      <section aria-label="Plan a run" className={`${cardClass} space-y-3`}>
        <h3 className="text-sm font-bold text-fg-strong">Plan a run</h3>
        <form
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
          onSubmit={(event) => {
            event.preventDefault();
            void act(() => createRunAction({ branchId: runBranch?.id ?? '', runDate: day, riderId: riderChoice?.id ?? '', riderName: rider, vehicle }), (d) => `Run ${d.number} is planned. Pick it below and put deliveries on it.`);
          }}
        >
          <ChoicePicker label="Leaves from" source="delivery-branches" choice={runBranch} onChoice={setRunBranch} placeholder="Choose the branch" />
          <Field id={`${uid}-day`} label="Day">
            <input id={`${uid}-day`} type="date" value={day} onChange={(e) => setDay(e.target.value)} className={fieldClass} />
          </Field>
          <ChoicePicker label="Rider" source="delivery-riders" choice={riderChoice} onChoice={setRiderChoice} placeholder="Choose a rider" clearable />
          <Field id={`${uid}-rider`} label="Or a name, for someone not using the app">
            <input id={`${uid}-rider`} value={rider} onChange={(e) => setRider(e.target.value)} maxLength={120} className={fieldClass} autoComplete="off" disabled={riderChoice !== null} />
          </Field>
          <Field id={`${uid}-veh`} label="Vehicle (optional)">
            <input id={`${uid}-veh`} value={vehicle} onChange={(e) => setVehicle(e.target.value)} maxLength={80} className={fieldClass} autoComplete="off" />
          </Field>
          <div className="sm:col-span-2 lg:col-span-4">
            <button type="submit" className={primaryClass} disabled={busy}>
              Plan the run
            </button>
          </div>
        </form>
      </section>

      <section aria-label="Runs to do" className="space-y-2">
        <h3 className="text-sm font-bold text-fg-strong">Runs to do</h3>
        {board.runs.length === 0 ? (
          <p role="status" className="text-sm text-fg-muted">
            No run is planned or on the road.
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2" aria-label="Open runs">
            {board.runs.map((r) => (
              <li key={r.id} className={`${cardClass} flex flex-wrap items-center justify-between gap-2`}>
                <div className="min-w-0">
                  <Link href={`/admin/delivery/runs/${r.id}`} className="min-h-10 py-2 font-mono text-sm font-semibold text-indigo-600 hover:underline dark:text-indigo-400">
                    {r.number}
                  </Link>
                  <p className="text-xs text-fg-muted">
                    {r.riderName} · {r.runDate} · {r.stops} {r.stops === 1 ? 'stop' : 'stops'}
                  </p>
                </div>
                <Chip tone={r.status === 'started' ? 'amber' : 'sky'}>{r.statusWords}</Chip>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Ready to go" className="space-y-3">
        <h3 className="text-sm font-bold text-fg-strong">Ready to go</h3>
        <div className="max-w-md">
          <ChoicePicker label="Put deliveries on this run" source="delivery-open-runs" choice={target} onChoice={setTarget} placeholder="Choose a run being planned" clearable />
        </div>
        {board.ready.length === 0 ? (
          <p role="status" className="text-sm text-fg-muted">
            Nothing is waiting. A delivery shows here once it is marked ready to go.
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2" aria-label="Deliveries ready to go">
            {board.ready.map((d) => (
              <li key={d.deliveryId} className={`${cardClass} space-y-1.5`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link href={`/admin/delivery/deliveries/${d.deliveryId}`} className="min-h-10 py-2 font-mono text-sm font-semibold text-indigo-600 hover:underline dark:text-indigo-400">
                    {d.number}
                  </Link>
                  {d.scheduledFor === null ? null : <Chip tone="sky">{`Wanted ${d.scheduledFor}`}</Chip>}
                  {d.promised === null ? null : <Chip tone={PROMISE_TONE[d.promised.state]}>{`Promised ${windowWords(new Date(d.promised.start), new Date(d.promised.end))}${d.promised.state === 'late' || d.promised.state === 'at_risk' ? ` · ${SLA_WORDS[d.promised.state]}` : ''}`}</Chip>}
                  {d.waiting === null ? null : <Chip tone={d.waiting.late ? 'red' : 'gray'}>{d.waiting.late ? `Waiting ${String(d.waiting.hours)}h` : `${String(d.waiting.hours)}h`}</Chip>}
                </div>
                <p className="text-sm text-fg-strong">{d.customerName}</p>
                <p className="text-xs text-fg-muted">
                  Order {d.orderNumber} · {d.area === '' ? 'No area given' : d.area} · from {d.branchName}
                </p>
                <p className="text-xs text-fg-muted">
                  {d.units} {d.units === 1 ? 'item' : 'items'} · KSh {money(d.value)}
                </p>
                <button type="button" className={buttonClass} disabled={busy || target === null} onClick={() => void act(() => runStepAction({ runId: target?.id, step: 'add_stop', deliveryId: d.deliveryId }), () => `${d.number} is on the run.`)}>
                  {target === null ? 'Choose a run first' : `Put ${d.number} on the run`}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="With couriers" className="space-y-3">
        <h3 className="text-sm font-bold text-fg-strong">With couriers</h3>
        {board.withCouriers.length === 0 ? (
          <p role="status" className="text-sm text-fg-muted">
            No parcel is out with a courier.
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2" aria-label="Parcels with couriers">
            {board.withCouriers.map((w) => {
              const n = news[w.deliveryId] ?? { state: null, note: '', receivedBy: '', tracking: '' };
              const set = (over: Partial<typeof n>) => setNews({ ...news, [w.deliveryId]: { ...n, ...over } });
              return (
                <li key={w.deliveryId} className={`${cardClass} space-y-1.5`}>
                  <Link href={`/admin/delivery/deliveries/${w.deliveryId}`} className="min-h-10 py-2 font-mono text-sm font-semibold text-indigo-600 hover:underline dark:text-indigo-400">
                    {w.number}
                  </Link>
                  <p className="text-sm text-fg-strong">{w.customerName}</p>
                  <p className="text-xs text-fg-muted">
                    {w.courierName}
                    {w.trackingNumber === null ? '' : ` · ${w.trackingNumber}`} · {w.lastNote ?? 'No news yet'}
                  </p>
                  {w.problem === null ? null : (
                    <p className="text-xs">
                      <Chip tone="red">Courier not booked</Chip> <span className="text-fg-muted">{w.problem} Open the delivery to try again or type its news in.</span>
                    </p>
                  )}
                  <details className="text-sm">
                    <summary className="min-h-10 cursor-pointer py-2 font-semibold text-indigo-500">Record the courier’s news for {w.number}</summary>
                    <div className="grid grid-cols-1 gap-3 pt-2">
                      <ChoicePicker label={`What the courier reported: ${w.number}`} source="courier-news" choice={n.state} onChoice={(c) => set({ state: c })} placeholder="Choose" clearable />
                      <Field id={`${uid}-nn-${w.deliveryId}`} label="Note">
                        <input id={`${uid}-nn-${w.deliveryId}`} value={n.note} onChange={(e) => set({ note: e.target.value })} maxLength={300} className={fieldClass} autoComplete="off" />
                      </Field>
                      {n.state?.id === 'delivered' ? (
                        <Field id={`${uid}-nr-${w.deliveryId}`} label="Who received it">
                          <input id={`${uid}-nr-${w.deliveryId}`} value={n.receivedBy} onChange={(e) => set({ receivedBy: e.target.value })} maxLength={120} className={fieldClass} autoComplete="off" />
                        </Field>
                      ) : null}
                      <button
                        type="button"
                        className={buttonClass}
                        disabled={busy || n.state === null}
                        onClick={() => void act(() => courierNewsAction({ deliveryId: w.deliveryId, state: n.state?.id, note: n.note, receivedBy: n.receivedBy, trackingNumber: n.tracking }), () => `The news for ${w.number} is recorded.`)}
                      >
                        Record the news
                      </button>
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
