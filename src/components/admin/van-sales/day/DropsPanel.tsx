'use client';

import { useState } from 'react';
import { addDropAction, closeDropAction, deliverDropAction, removeDropAction, type DayScreen } from '@/server/domains/van-sales/actions';
import type { DropView } from '@/server/domains/van-sales/drops';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { Chip, buttonClass, cardClass, primaryClass } from '@/components/ui/screen-kit';
import type { Choice } from '@/lib/payment-options';
import { kes } from '@/lib/till/tile-style';
import { WhyPanel } from '../WhyPanel';
import type { DayCall } from './call';

const STOCK_TONE = { at_warehouse: 'sky', on_the_way: 'amber', on_van: 'green', short: 'amber' } as const;
const STATE_TONE = { planned: 'sky', delivered: 'green', partly: 'amber', refused: 'gray', failed: 'gray' } as const;
const inputClass = 'min-h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm';

/** The orders to deliver from the van on the day: the planner adds them before the day goes out, and the rep delivers them at the customer. */
export function DropsPanel({ screen, run }: { screen: DayScreen; run: DayCall }) {
  const { day, visits } = screen.detail;
  const [adding, setAdding] = useState(false);
  const [order, setOrder] = useState<Choice | null>(null);
  const [fresh, setFresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (screen.drops.length === 0 && !screen.canAddDrops) return null;
  const add = async () => {
    setBusy(true);
    setProblem(null);
    const answer = await run(addDropAction({ dayId: day.id, orderId: order?.id ?? '' }), `${order?.label ?? 'The order'} is on the deliveries.`);
    setBusy(false);
    if (answer === null) {
      setOrder(null);
      setFresh((f) => f + 1);
      setAdding(false);
    } else setProblem(answer);
  };
  return (
    <section className={`${cardClass} space-y-3`} aria-label="Deliveries">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 basis-48 text-base font-bold text-fg-strong">Deliveries</h2>
        {screen.canAddDrops && !adding ? <button type="button" className={buttonClass} onClick={() => setAdding(true)}>Add an order</button> : null}
      </div>
      {adding ? (
        <form aria-label="Add an order to deliver" className="space-y-3 rounded-lg border border-line bg-surface-sunken p-3" onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <ChoicePicker key={fresh} label="Order" source="van-day-orders" filters={{ day: day.id }} choice={order} onChoice={setOrder} placeholder="Search by order number or customer…" required />
          {problem === null ? null : <p role="alert" className="text-sm text-red-700">{problem}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={primaryClass} disabled={busy || order === null}>{busy ? 'Adding…' : 'Add to the deliveries'}</button>
            <button type="button" className={buttonClass} onClick={() => { setAdding(false); setProblem(null); }} disabled={busy}>Cancel</button>
          </div>
        </form>
      ) : null}
      {screen.drops.length === 0 ? (
        <p role="status" className="rounded-lg border border-line p-6 text-center text-sm text-fg-muted">No order is to be delivered on this day.</p>
      ) : (
        <ul className="space-y-2" aria-label="Orders to deliver">
          {screen.drops.map((d) => (
            <DropRow key={d.id} drop={d} screen={screen} atCustomer={visits.some((v) => v.id === d.visitId && v.status === 'arrived')} run={run} />
          ))}
        </ul>
      )}
    </section>
  );
}

function DropRow({ drop, screen, atCustomer, run }: { drop: DropView; screen: DayScreen; atCustomer: boolean; run: DayCall }) {
  const dayId = screen.detail.day.id;
  const mayDeliver = screen.isRep && screen.maySell && screen.detail.day.status === 'out' && drop.state === 'planned';
  const [mode, setMode] = useState<'view' | 'deliver' | 'refuse' | 'fail'>('view');
  const [receivedBy, setReceivedBy] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const done = async (call: Parameters<DayCall>[0], text: string) => {
    setBusy(true);
    setProblem(null);
    const answer = await run(call, text);
    setBusy(false);
    if (answer === null) setMode('view');
    else setProblem(answer);
  };
  return (
    <li className="space-y-2 rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1 basis-48">
          <p className="text-sm font-semibold text-fg-strong">{drop.orderNumber} · {drop.customerName}</p>
          <p className="text-xs text-fg-muted">{drop.lines.map((l) => `${String(l.quantity)} × ${l.name}`).join(', ')} · {kes(drop.total)}</p>
          {drop.reason === null ? null : <p className="text-xs text-fg-muted">Because: {drop.reason}</p>}
        </div>
        <Chip tone={STATE_TONE[drop.state]}>{drop.stateWords}</Chip>
        {drop.state === 'planned' ? <Chip tone={STOCK_TONE[drop.stock]}>{drop.stockWords}</Chip> : null}
      </div>
      {screen.canPlan && drop.removable ? (
        <InlineConfirm label={`Take ${drop.orderNumber} off the deliveries`} action="Take off" confirm="Yes, take off" onConfirm={() => void run(removeDropAction({ dayId, id: drop.id }), `${drop.orderNumber} is off the deliveries.`)} />
      ) : null}
      {mayDeliver && atCustomer && mode === 'view' ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={primaryClass} onClick={() => setMode('deliver')} aria-label={`Deliver ${drop.orderNumber}`}>Deliver</button>
          <button type="button" className={buttonClass} onClick={() => setMode('refuse')} aria-label={`${drop.orderNumber} was refused`}>Refused</button>
          <button type="button" className={buttonClass} onClick={() => setMode('fail')} aria-label={`${drop.orderNumber} could not be delivered`}>Could not deliver</button>
        </div>
      ) : null}
      {mayDeliver && !atCustomer ? <p className="text-xs text-fg-muted">Arrive at {drop.customerName} to deliver this.</p> : null}
      {mode === 'deliver' ? (
        <form aria-label={`Deliver ${drop.orderNumber}`} className="space-y-2 rounded-lg border border-line bg-surface-sunken p-3" onSubmit={(e) => { e.preventDefault(); void done(deliverDropAction({ dayId, id: drop.id, receivedBy }), `${drop.orderNumber} is delivered to ${drop.customerName}.`); }}>
          <label className="block text-xs text-fg-muted">Who received it
            <input className={inputClass} value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)} aria-label="Who received the goods" autoComplete="off" />
          </label>
          {problem === null ? null : <p role="alert" className="text-sm text-red-700">{problem}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={primaryClass} disabled={busy || receivedBy.trim().length < 2}>{busy ? 'Delivering…' : 'Delivered'}</button>
            <button type="button" className={buttonClass} onClick={() => { setMode('view'); setProblem(null); }} disabled={busy}>Cancel</button>
          </div>
        </form>
      ) : null}
      {mode === 'refuse' || mode === 'fail' ? (
        <WhyPanel label={mode === 'refuse' ? `Refused ${drop.orderNumber}` : `Not delivered ${drop.orderNumber}`} action={mode === 'refuse' ? 'Record the refusal' : 'Record that it was not delivered'} busy={busy} onCancel={() => setMode('view')} onConfirm={(reason) => void done(closeDropAction({ dayId, id: drop.id, state: mode === 'refuse' ? 'refused' : 'failed', reason }), `${drop.orderNumber} was not delivered.`)} />
      ) : null}
    </li>
  );
}
