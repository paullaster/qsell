'use client';

import { useEffect, useId, useState } from 'react';
import { routeDueAction, type RouteScreen } from '@/server/domains/van-sales/actions';
import type { StopView } from '@/server/domains/van-sales/routes';
import { Chip, Field, cardClass, fieldClass, today } from '@/components/ui/screen-kit';
import { dayNumber, weekdayIndex, WEEKDAY_NAMES } from '@/lib/van-sales/visits';

/** Who is to be visited on a day: pick a date and see the customers due, in the order of the round. */
export function DuePanel({ screen }: { screen: RouteScreen }) {
  const uid = useId();
  const [date, setDate] = useState(() => today());
  const [due, setDue] = useState<StopView[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // The list is read again when the date or any stop changes.
  const stopsKey = screen.stops.map((s) => `${s.id}:${String(s.version)}:${String(s.sequence)}`).join(',');
  const routeId = screen.route.id;
  useEffect(() => {
    let current = true;
    void routeDueAction({ routeId, date }).then((r) => {
      if (!current) return;
      if (r.ok) { setDue(r.data); setProblem(null); } else { setDue(null); setProblem(r.error); }
    });
    return () => { current = false; };
  }, [routeId, date, stopsKey]);
  const day = dayNumber(date);
  const dayName = day === null ? null : WEEKDAY_NAMES[weekdayIndex(day)];
  return (
    <section className={`${cardClass} space-y-3`} aria-label="Who is due on a day">
      <div>
        <h2 className="text-base font-bold text-fg-strong">Who is due on a day</h2>
        <p className="text-sm text-fg-muted">Pick a date to see the customers a rep would visit, in the order of the round.</p>
      </div>
      <div className="max-w-xs">
        <Field id={`${uid}-date`} label="Date"><input id={`${uid}-date`} type="date" className={fieldClass} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
      {problem === null ? null : <p role="alert" className="text-sm text-red-700">{problem}</p>}
      {due === null ? null : (
        <div aria-live="polite" className="space-y-2">
          <p className="text-sm font-semibold text-fg-strong" data-testid="due-count">{dayName === null || dayName === undefined ? '' : `${dayName}: `}{due.length === 0 ? 'nobody is due' : `${String(due.length)} ${due.length === 1 ? 'customer' : 'customers'} due`}</p>
          {due.length === 0 ? null : (
            <ol className="space-y-1" aria-label="Due on this day">
              {due.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-semibold">{s.customerName}</span>
                  <span className="text-fg-muted">{s.visitWords}</span>
                  {s.customerWarning === null ? null : <Chip tone="amber">{s.customerWarning}</Chip>}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}
