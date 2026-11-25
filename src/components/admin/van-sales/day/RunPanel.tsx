'use client';

import { useId, useState } from 'react';
import { sendOutAction, type DayScreen } from '@/server/domains/van-sales/actions';
import { Field, Chip, cardClass, fieldClass, primaryClass } from '@/components/ui/screen-kit';
import type { DayCall } from './call';

/** Sending the day out. The rep does it, counting the cash into the van's till; everyone else sees where it stands and what is missing. */
export function RunPanel({ screen, run }: { screen: DayScreen; run: DayCall }) {
  const uid = useId();
  const { day } = screen.detail;
  const [cash, setCash] = useState('0');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (day.status !== 'planned' && day.status !== 'loading') return null;
  const mayRun = screen.isRep && screen.maySell;
  const sellsFromVan = day.vanId !== null;
  const send = async () => {
    setBusy(true);
    setProblem(null);
    const answer = await run(sendOutAction({ dayId: day.id, float: cash, expectedVersion: day.version }), 'The day is out on the route.');
    setBusy(false);
    if (answer !== null) setProblem(answer);
  };
  return (
    <section className={`${cardClass} space-y-3`} aria-label="Send the day out">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 basis-48 text-base font-bold text-fg-strong">Send the day out</h2>
        {screen.outProblem === null ? <Chip tone="green">Ready to go</Chip> : <Chip tone="amber">Not ready</Chip>}
      </div>
      {screen.outProblem === null ? null : <p role="status" className="text-sm text-fg-muted">{screen.outProblem}</p>}
      {mayRun ? (
        <form aria-label="Send the day out" className="space-y-3" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          {sellsFromVan ? (
            <Field id={`${uid}-float`} label="Cash counted into the van's till (KES)" hint="Count the float you start with. Put 0 if the till starts empty.">
              <input id={`${uid}-float`} className={`${fieldClass} max-w-xs`} inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} autoComplete="off" />
            </Field>
          ) : (
            <p className="text-sm text-fg-muted">This day only takes orders, so there is no till and no float.</p>
          )}
          {problem === null ? null : <p role="alert" className="text-sm text-red-700">{problem}</p>}
          <button type="submit" className={primaryClass} disabled={busy || screen.outProblem !== null}>{busy ? 'Sending out…' : 'Send the day out'}</button>
        </form>
      ) : (
        <p className="text-sm text-fg-muted">{screen.detail.day.repName} sends the day out once the van is loaded, counting the cash into the till.</p>
      )}
    </section>
  );
}
