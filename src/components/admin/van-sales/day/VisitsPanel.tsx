'use client';

import { useState } from 'react';
import { addVisitAction, moveVisitAction, removeVisitAction, type DayScreen } from '@/server/domains/van-sales/actions';
import type { VisitView } from '@/server/domains/van-sales/days';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { Chip, buttonClass, cardClass, primaryClass } from '@/components/ui/screen-kit';
import type { Choice } from '@/lib/payment-options';
import { canArrangeVisits, VISIT_STATUS_WORDS } from '@/lib/van-sales/days';
import type { DayCall } from './call';

/** The customers to visit on the day, in order. While the day is being got ready they can be added, moved and taken off. */
export function VisitsPanel({ screen, run }: { screen: DayScreen; run: DayCall }) {
  const { day, visits } = screen.detail;
  const may = screen.canPlan && canArrangeVisits(day.status);
  const [adding, setAdding] = useState(false);
  const [customer, setCustomer] = useState<Choice | null>(null);
  const [fresh, setFresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const add = async () => {
    setBusy(true);
    setProblem(null);
    const answer = await run(addVisitAction({ dayId: day.id, customerId: customer?.id ?? '' }), `${customer?.label ?? 'The customer'} is on the day's visits.`);
    setBusy(false);
    if (answer === null) {
      setCustomer(null);
      setFresh((f) => f + 1);
      setAdding(false);
    } else setProblem(answer);
  };
  return (
    <section className={`${cardClass} space-y-3`} aria-label="Visits">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 basis-48 text-base font-bold text-fg-strong">Visits</h2>
        {may && !adding ? <button type="button" className={buttonClass} onClick={() => setAdding(true)}>Add a customer</button> : null}
      </div>
      {adding ? (
        <form aria-label="Add a customer to the day" className="space-y-3 rounded-lg border border-line bg-surface-sunken p-3" onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <ChoicePicker key={fresh} label="Customer" source="van-plan-customers" filters={{ day: day.id }} choice={customer} onChoice={setCustomer} placeholder="Search customers by name, phone or number…" required />
          {problem === null ? null : <p role="alert" className="text-sm text-red-700">{problem}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={primaryClass} disabled={busy || customer === null}>{busy ? 'Adding…' : 'Add to the visits'}</button>
            <button type="button" className={buttonClass} onClick={() => { setAdding(false); setProblem(null); }} disabled={busy}>Cancel</button>
          </div>
        </form>
      ) : null}
      {visits.length === 0 ? (
        <p role="status" className="rounded-lg border border-line p-6 text-center text-sm text-fg-muted">No customer on this day.</p>
      ) : (
        <ol className="space-y-2" aria-label="Visits in order">
          {visits.map((v, i) => <VisitRow key={v.id} visit={v} first={i === 0} last={i === visits.length - 1} dayId={day.id} may={may} run={run} />)}
        </ol>
      )}
    </section>
  );
}

function VisitRow({ visit, first, last, dayId, may, run }: { visit: VisitView; first: boolean; last: boolean; dayId: string; may: boolean; run: DayCall }) {
  const where = [visit.customerPlace, visit.customerPhone].filter((x): x is string => x !== null && x !== '').join(' · ');
  return (
    <li className="space-y-2 rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-indigo-500/10 text-sm font-bold text-indigo-700" aria-label={`Visit ${String(visit.sequence)}`}>{visit.sequence}</span>
        <div className="min-w-0 flex-1 basis-48">
          <p className="text-sm font-semibold text-fg-strong">{visit.customerName}</p>
          <p className="text-xs text-fg-muted">{where === '' ? 'No address or phone on the customer card' : where}</p>
          {visit.note === null ? null : <p className="text-xs text-fg-muted">Note: {visit.note}</p>}
          {visit.fromRoute ? null : <p className="text-xs text-fg-muted">Added to this day by hand</p>}
        </div>
        <Chip tone={visit.status === 'planned' ? 'sky' : 'green'}>{VISIT_STATUS_WORDS[visit.status]}</Chip>
        {visit.customerWarning === null ? null : <Chip tone="amber">{visit.customerWarning}</Chip>}
      </div>
      {may && visit.status === 'planned' ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonClass} disabled={first} onClick={() => void run(moveVisitAction({ dayId, id: visit.id, by: -1 }), `${visit.customerName} moved up.`)} aria-label={`Move ${visit.customerName} up`}>Up</button>
          <button type="button" className={buttonClass} disabled={last} onClick={() => void run(moveVisitAction({ dayId, id: visit.id, by: 1 }), `${visit.customerName} moved down.`)} aria-label={`Move ${visit.customerName} down`}>Down</button>
          <InlineConfirm label={`Take ${visit.customerName} off the day`} action="Take off the day" confirm="Yes, take off" onConfirm={() => void run(removeVisitAction({ dayId, id: visit.id }), `${visit.customerName} is off the day's visits.`)} />
        </div>
      ) : null}
    </li>
  );
}
