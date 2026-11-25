'use client';

import { useId, useState } from 'react';
import { planDayAction } from '@/server/domains/van-sales/actions';
import type { DayDetail } from '@/server/domains/van-sales/days';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { Field, attempt, buttonClass, fieldClass, primaryClass, today } from '@/components/ui/screen-kit';
import type { Choice } from '@/lib/payment-options';

/** Plans a day: the route and the date. The route's usual van and rep are used unless others are chosen for the day. */
export function PlanForm({ onPlanned, onCancel }: { onPlanned: (day: DayDetail) => void; onCancel: () => void }) {
  const uid = useId();
  const [route, setRoute] = useState<Choice | null>(null);
  const [date, setDate] = useState(() => today());
  const [rep, setRep] = useState<Choice | null>(null);
  const [van, setVan] = useState<Choice | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const preSell = route?.meta?.mode === 'pre_sell';
  const save = async () => {
    setBusy(true);
    setProblem(null);
    const r = await attempt(planDayAction({ routeId: route?.id ?? '', date, repId: rep?.id ?? null, vanId: preSell ? null : (van?.id ?? null) }));
    setBusy(false);
    if (r.ok) onPlanned(r.data);
    else setProblem(r.error);
  };
  return (
    <form aria-label="Plan a day" className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <ChoicePicker label="Route" source="van-plan-routes" choice={route} onChoice={(r) => { setRoute(r); setVan(null); }} placeholder="Search routes by name or code…" required />
      <Field id={`${uid}-date`} label="Date" hint="Today or a later date. The customers due that day are put on the day.">
        <input id={`${uid}-date`} type="date" className={fieldClass} value={date} min={today()} onChange={(e) => setDate(e.target.value)} />
      </Field>
      <ChoicePicker label="Sales rep (optional)" source="van-plan-reps" choice={rep} onChoice={setRep} placeholder="The route's usual rep" clearable />
      {preSell ? (
        <p className="self-end text-sm text-fg-muted">A route that only takes orders has no van.</p>
      ) : (
        <ChoicePicker label="Van (optional)" source="van-plan-vans" choice={van} onChoice={setVan} placeholder="The route's usual van" clearable />
      )}
      {problem === null ? null : <p role="alert" className="text-sm text-red-700 sm:col-span-2">{problem}</p>}
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <button type="submit" className={primaryClass} disabled={busy}>{busy ? 'Planning…' : 'Plan the day'}</button>
        <button type="button" className={buttonClass} onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}
