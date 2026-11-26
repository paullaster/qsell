'use client';

import { useState } from 'react';
import { cashDropAction, type DayScreen } from '@/server/domains/van-sales/actions';
import { useWhen } from '@/components/business-time';
import { Chip, buttonClass, cardClass, primaryClass } from '@/components/ui/screen-kit';
import { kes } from '@/lib/till/tile-style';
import { DROP_DESTINATIONS, DROP_DESTINATION_WORDS, type DropDestination } from '@/lib/van-sales/cash';
import type { DayCall } from './call';

const inputClass = 'min-h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm';
const TONE = { ok: 'green', near: 'amber', over: 'red', no_limit: 'gray' } as const;
const STATE_WORDS = { ok: 'Within the limit', near: 'Near the limit', over: 'Over the limit', no_limit: 'No limit set' } as const;

/** The cash the van's till should hold against its limit, and the cash drops that keep it under: the rep takes cash off the van to the safe, a bank run or the office. */
export function CashPanel({ screen, run }: { screen: DayScreen; run: DayCall }) {
  const when = useWhen();
  const view = screen.cash;
  const status = screen.detail.day.status;
  const mayDrop = screen.isRep && screen.maySell && (status === 'out' || status === 'returning');
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [destination, setDestination] = useState<DropDestination>('safe');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (view === null) return null;
  const submit = async () => {
    setBusy(true);
    setProblem(null);
    const answer = await run(cashDropAction({ dayId: screen.detail.day.id, amount, destination, note }), `${kes(Number(amount))} was taken off the van to ${DROP_DESTINATION_WORDS[destination].toLowerCase()}.`);
    setBusy(false);
    if (answer === null) {
      setOpen(false);
      setAmount('');
      setNote('');
    } else setProblem(answer);
  };
  return (
    <section className={`${cardClass} space-y-3`} aria-label="Cash on the van">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 basis-48 text-base font-bold text-fg-strong">Cash on the van</h2>
        <span className="font-mono text-base font-bold text-fg-strong" data-testid="van-cash">{kes(view.cash)}</span>
        <Chip tone={TONE[view.state]}>{STATE_WORDS[view.state]}</Chip>
      </div>
      {view.limit === null ? null : <p className="text-xs text-fg-muted">Limit {kes(view.limit)}</p>}
      {view.words === null ? null : <p role={view.state === 'over' ? 'alert' : 'status'} className={view.state === 'over' ? 'text-sm font-semibold text-red-700' : 'text-sm text-amber-700'}>{view.words}</p>}
      {mayDrop && !open ? <button type="button" className={view.state === 'ok' || view.state === 'no_limit' ? buttonClass : primaryClass} onClick={() => setOpen(true)}>Take cash off the van</button> : null}
      {open ? (
        <form aria-label="Take cash off the van" className="space-y-3 rounded-lg border border-line bg-surface-sunken p-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <label className="block text-xs text-fg-muted">Amount (KES)
            <input className={inputClass} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Cash taken off the van" />
          </label>
          <div role="group" aria-label="Where the cash goes" className="flex flex-wrap gap-2">
            {DROP_DESTINATIONS.map((d) => <button key={d} type="button" className={destination === d ? primaryClass : buttonClass} aria-pressed={destination === d} onClick={() => setDestination(d)}>{DROP_DESTINATION_WORDS[d]}</button>)}
          </div>
          <label className="block text-xs text-fg-muted">Note (optional)
            <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note on the cash drop" maxLength={200} />
          </label>
          {problem === null ? null : <p role="alert" className="text-sm text-red-700">{problem}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={primaryClass} disabled={busy || amount.trim() === ''}>{busy ? 'Saving…' : 'Take it off the van'}</button>
            <button type="button" className={buttonClass} onClick={() => { setOpen(false); setProblem(null); }} disabled={busy}>Cancel</button>
          </div>
        </form>
      ) : null}
      {view.drops.length === 0 ? null : (
        <ul className="space-y-2" aria-label="Cash drops">
          {view.drops.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-3 text-sm">
              <span className="min-w-0 flex-1 basis-40"><span className="font-semibold text-fg-strong">{d.destinationWords}</span> <span className="text-fg-muted">{when(d.at)}{d.note === null ? '' : ` · ${d.note}`}</span></span>
              <span className="font-mono font-semibold">{kes(d.amount)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
