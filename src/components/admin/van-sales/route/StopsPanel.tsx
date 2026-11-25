'use client';

import { useId, useState } from 'react';
import { addStopAction, moveStopAction, removeStopAction, updateStopAction, type RouteScreen } from '@/server/domains/van-sales/actions';
import type { StopView } from '@/server/domains/van-sales/routes';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { Chip, Field, buttonClass, cardClass, fieldClass, primaryClass, today } from '@/components/ui/screen-kit';
import type { Choice } from '@/lib/payment-options';
import { EVERY_WEEKS, type EveryWeeks } from '@/lib/van-sales/visits';
import type { RouteCall } from './call';
import { WeekdayPicker } from './WeekdayPicker';

const EVERY_WORDS: Record<EveryWeeks, string> = { 1: 'Every week', 2: 'Every 2 weeks', 4: 'Every 4 weeks' };

/** The customers on the route in the order of the round: put one on, change its days, move it, take it off. */
export function StopsPanel({ screen, run }: { screen: RouteScreen; run: RouteCall }) {
  const [adding, setAdding] = useState(false);
  const may = screen.canManage && screen.route.status === 'active';
  return (
    <section className={`${cardClass} space-y-3`} aria-label="Customers on this route">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 basis-48 text-base font-bold text-fg-strong">Customers on this route</h2>
        {may && !adding ? <button type="button" className={primaryClass} onClick={() => setAdding(true)}>Add a customer</button> : null}
      </div>
      {adding ? (
        <StopForm routeId={screen.route.id} onCancel={() => setAdding(false)} run={run} onDone={() => setAdding(false)} />
      ) : null}
      {screen.stops.length === 0 ? (
        <p role="status" className="rounded-lg border border-line p-6 text-center text-sm text-fg-muted">No customer on this route yet. Add the first one, with the days they are visited.</p>
      ) : (
        <ol className="space-y-2" aria-label="The round">
          {screen.stops.map((s, i) => <StopRow key={s.id} stop={s} first={i === 0} last={i === screen.stops.length - 1} screen={screen} may={may} run={run} />)}
        </ol>
      )}
    </section>
  );
}

function StopRow({ stop, first, last, screen, may, run }: { stop: StopView; first: boolean; last: boolean; screen: RouteScreen; may: boolean; run: RouteCall }) {
  const [editing, setEditing] = useState(false);
  const routeId = screen.route.id;
  const where = [stop.customerPlace, stop.customerPhone].filter((x): x is string => x !== null && x !== '').join(' · ');
  return (
    <li className="space-y-2 rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-indigo-500/10 text-sm font-bold text-indigo-700" aria-label={`Stop ${String(stop.sequence)}`}>{stop.sequence}</span>
        <div className="min-w-0 flex-1 basis-48">
          <p className="text-sm font-semibold text-fg-strong">{stop.customerName}</p>
          <p className="text-xs text-fg-muted">{where === '' ? 'No address or phone on the customer card' : where}</p>
          <p className="mt-1 text-sm">{stop.visitWords}</p>
          {stop.note === null ? null : <p className="text-xs text-fg-muted">Note: {stop.note}</p>}
        </div>
        {stop.customerWarning === null ? null : <Chip tone="amber">{stop.customerWarning}</Chip>}
      </div>
      {may && !editing ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonClass} disabled={first} onClick={() => void run(moveStopAction({ routeId, id: stop.id, by: -1 }), `${stop.customerName} moved up.`)} aria-label={`Move ${stop.customerName} up`}>Up</button>
          <button type="button" className={buttonClass} disabled={last} onClick={() => void run(moveStopAction({ routeId, id: stop.id, by: 1 }), `${stop.customerName} moved down.`)} aria-label={`Move ${stop.customerName} down`}>Down</button>
          <button type="button" className={buttonClass} onClick={() => setEditing(true)} aria-label={`Change the visits to ${stop.customerName}`}>Change days</button>
          <InlineConfirm label={`Take ${stop.customerName} off this route`} action="Take off route" confirm="Yes, take off" onConfirm={() => void run(removeStopAction({ routeId, id: stop.id, expectedVersion: stop.version }), `${stop.customerName} is off the route.`)} />
        </div>
      ) : null}
      {editing ? <StopForm routeId={routeId} stop={stop} run={run} onCancel={() => setEditing(false)} onDone={() => setEditing(false)} /> : null}
    </li>
  );
}

function StopForm({ routeId, stop, run, onCancel, onDone }: { routeId: string; stop?: StopView; run: RouteCall; onCancel: () => void; onDone: () => void }) {
  const uid = useId();
  const [customer, setCustomer] = useState<Choice | null>(stop === undefined ? null : { id: stop.customerId, label: stop.customerName });
  const [days, setDays] = useState(stop?.visitDays ?? 0);
  const [every, setEvery] = useState<EveryWeeks>(stop?.every ?? 1);
  const [anchor, setAnchor] = useState(() => stop?.anchor ?? today());
  const [note, setNote] = useState(stop?.note ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const submitWords = stop === undefined ? 'Put on the route' : 'Save';
  const save = async () => {
    setBusy(true);
    setProblem(null);
    const body = { routeId, customerId: customer?.id ?? '', visitDays: days, every, anchor, note };
    const answer = stop === undefined ? await run(addStopAction(body), `${customer?.label ?? 'The customer'} is on the route.`) : await run(updateStopAction({ ...body, id: stop.id, expectedVersion: stop.version }), `The visits to ${stop.customerName} are saved.`);
    setBusy(false);
    if (answer === null) onDone();
    else setProblem(answer);
  };
  return (
    <form aria-label={stop === undefined ? 'Add a customer to the route' : `Change the visits to ${stop.customerName}`} className="grid gap-3 rounded-lg border border-line bg-surface-sunken p-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      {stop === undefined ? (
        <div className="sm:col-span-2"><ChoicePicker label="Customer" source="van-customers" filters={{ route: routeId }} choice={customer} onChoice={setCustomer} placeholder="Search customers by name, phone or number…" required /></div>
      ) : null}
      <div className="sm:col-span-2"><WeekdayPicker value={days} onChange={setDays} /></div>
      <fieldset className="space-y-1">
        <legend className="mb-1 text-sm font-semibold text-fg-strong">How often</legend>
        {EVERY_WEEKS.map((e) => (
          <label key={e} className="flex min-h-10 cursor-pointer items-center gap-2 text-sm">
            <input type="radio" name={`${uid}-every`} className="size-4" checked={every === e} onChange={() => setEvery(e)} />
            {EVERY_WORDS[e]}
          </label>
        ))}
      </fieldset>
      <Field id={`${uid}-from`} label="Visits start from" hint="A date in the first week. Every 2 or 4 weeks are counted from that week.">
        <input id={`${uid}-from`} type="date" className={fieldClass} value={anchor} onChange={(e) => setAnchor(e.target.value)} />
      </Field>
      <div className="sm:col-span-2">
        <Field id={`${uid}-note`} label="Note for the rep (optional)" hint="For example: gate at the back, ask for the manager"><input id={`${uid}-note`} className={fieldClass} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} autoComplete="off" /></Field>
      </div>
      {problem === null ? null : <p role="alert" className="text-sm text-red-700 sm:col-span-2">{problem}</p>}
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <button type="submit" className={primaryClass} disabled={busy}>{busy ? 'Saving…' : submitWords}</button>
        <button type="button" className={buttonClass} onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}
