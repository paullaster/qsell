'use client';

import { useState } from 'react';
import { useWhen } from '@/components/business-time';
import { addOnRouteAction, addVisitAction, arriveAction, closedShopAction, finishVisitAction, moveVisitAction, removeVisitAction, skipVisitAction, type DayScreen } from '@/server/domains/van-sales/actions';
import type { VisitView } from '@/server/domains/van-sales/days';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { Chip, buttonClass, cardClass, primaryClass } from '@/components/ui/screen-kit';
import type { Choice } from '@/lib/payment-options';
import { canArrangeVisits, VISIT_STATUS_WORDS } from '@/lib/van-sales/days';
import { currentPosition } from '@/lib/browser-position';
import { WhyPanel } from '../WhyPanel';
import { ContactLinks } from './ContactLinks';
import type { DayCall } from './call';
import { CollectForm } from './CollectForm';
import { ReturnForm } from './ReturnForm';
import { SellForm } from './SellForm';

/** The customers to visit on the day, in order. While the day is being got ready they can be added, moved and taken off. */
export function VisitsPanel({ screen, run, nextStopId }: { screen: DayScreen; run: DayCall; /** The customer shown in a Next stop card above the list, whose contact links are not repeated here. */ nextStopId?: string }) {
  const { day, visits } = screen.detail;
  const may = screen.canPlan && canArrangeVisits(day.status);
  const mayRun = screen.isRep && screen.maySell && day.status === 'out';
  const mayAddOnRoute = mayRun && screen.offRouteAllowed;
  const [adding, setAdding] = useState(false);
  const [customer, setCustomer] = useState<Choice | null>(null);
  const [fresh, setFresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const add = async () => {
    setBusy(true);
    setProblem(null);
    const answer = await run((mayAddOnRoute ? addOnRouteAction : addVisitAction)({ dayId: day.id, customerId: customer?.id ?? '' }), `${customer?.label ?? 'The customer'} is on the day's visits.`);
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
        {(may || mayAddOnRoute) && !adding ? <button type="button" className={buttonClass} onClick={() => setAdding(true)}>Add a customer</button> : null}
      </div>
      {adding ? (
        <form aria-label="Add a customer to the day" className="space-y-3 rounded-lg border border-line bg-surface-sunken p-3" onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <ChoicePicker key={fresh} label="Customer" source={mayAddOnRoute ? 'van-rep-customers' : 'van-plan-customers'} filters={{ day: day.id }} choice={customer} onChoice={setCustomer} placeholder="Search customers by name, phone or number…" required />
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
          {visits.map((v, i) => <VisitRow key={v.id} visit={v} first={i === 0} last={i === visits.length - 1} screen={screen} may={may} mayRun={mayRun} run={run} showContact={v.id !== nextStopId} />)}
        </ol>
      )}
    </section>
  );
}

function VisitRow({ visit, first, last, screen, may, mayRun, run, showContact }: { visit: VisitView; first: boolean; last: boolean; screen: DayScreen; may: boolean; mayRun: boolean; run: DayCall; showContact: boolean }) {
  const dayId = screen.detail.day.id;
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
      <VisitFacts visit={visit} />
      {showContact && (visit.status === 'planned' || visit.status === 'arrived') ? <ContactLinks visit={visit} /> : null}
      {mayRun ? <RunActions visit={visit} screen={screen} run={run} /> : null}
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

/** What happened at the visit, in words: when the rep arrived and how far from the shop, how it ended, and why. */
const OUTCOME_WORDS: Record<string, string> = { sold: 'Sold', order_taken: 'Order taken', sold_and_ordered: 'Sold and order taken', delivered_only: 'Delivered', collected_only: 'Collected', returned_only: 'Goods returned', no_sale: 'No sale' };

function VisitFacts({ visit }: { visit: VisitView }) {
  const when = useWhen();
  if (visit.arrivedAt === null && visit.noSaleReason === null && visit.outcome === null) return null;
  return (
    <p className="text-xs text-fg-muted" data-testid="visit-facts">
      {visit.arrivedAt === null ? '' : `Arrived ${when(visit.arrivedAt)}${visit.distanceM === null ? '' : `, ${String(visit.distanceM)} m from the shop`}. `}
      {OUTCOME_WORDS[visit.outcome ?? ''] ?? ''}
      {visit.noSaleReason === null ? '' : `${visit.outcome === 'no_sale' ? ': ' : 'Because: '}${visit.noSaleReason}`}
    </p>
  );
}

/** The rep's steps at a customer: arrive (the phone says where it is), finish with no sale, skip, or find the shop shut. */
function RunActions({ visit, screen, run }: { visit: VisitView; screen: DayScreen; run: DayCall }) {
  const dayId = screen.detail.day.id;
  const mayVanSell = screen.detail.day.vanName !== null && screen.detail.day.mode !== 'pre_sell';
  const mayOrder = screen.ordersAllowed;
  const owing = screen.owing.find((o) => o.visitId === visit.id && o.total > 0);
  const returnable = screen.returnable.filter((r) => r.visitId === visit.id);
  const [mode, setMode] = useState<'view' | 'skip' | 'finish' | 'sell' | 'order' | 'collect' | 'return'>('view');
  const [busy, setBusy] = useState(false);
  const name = visit.customerName;
  const go = async (call: Parameters<DayCall>[0], text: string) => {
    setBusy(true);
    const answer = await run(call, text);
    setBusy(false);
    if (answer === null) setMode('view');
  };
  const arrive = async () => {
    setBusy(true);
    const position = await currentPosition();
    const answer = await run(arriveAction({ dayId, id: visit.id, position, deviceTime: new Date().toISOString() }), `You are at ${name}.`);
    setBusy(false);
    if (answer === null) setMode('view');
  };
  const sales = screen.sales.rows.filter((r) => r.visitId === visit.id).length + screen.drops.filter((d) => d.visitId === visit.id && d.state === 'delivered').length + screen.collections.filter((c) => c.visitId === visit.id).length + screen.returns.filter((r) => r.visitId === visit.id).length;
  if (visit.status === 'done' || visit.status === 'skipped' || visit.status === 'closed_shop') return null;
  return (
    <div className="space-y-2">
      {mode === 'view' ? (
        <div className="flex flex-wrap gap-2">
          {visit.status === 'planned' ? <button type="button" className={primaryClass} disabled={busy} onClick={() => void arrive()} aria-label={`Arrive at ${name}`}>{busy ? 'Arriving…' : 'Arrive'}</button> : null}
          {visit.status === 'arrived' && mayVanSell ? <button type="button" className={primaryClass} onClick={() => setMode('sell')} aria-label={`Sell to ${name}`}>Sell</button> : null}
          {visit.status === 'arrived' && owing !== undefined && screen.tenders.length > 0 ? <button type="button" className={buttonClass} onClick={() => setMode('collect')} aria-label={`Collect from ${name}`}>Collect</button> : null}
          {visit.status === 'arrived' && returnable.length > 0 && screen.refundMethods.length > 0 ? <button type="button" className={buttonClass} onClick={() => setMode('return')} aria-label={`Take goods back from ${name}`}>Return</button> : null}
          {visit.status === 'arrived' && mayOrder ? <button type="button" className={mayVanSell ? buttonClass : primaryClass} onClick={() => setMode('order')} aria-label={`Take an order from ${name}`}>Take an order</button> : null}
          {visit.status === 'arrived' && sales === 0 ? <button type="button" className={buttonClass} onClick={() => setMode('finish')} aria-label={`Finish the visit to ${name} with no sale`}>Finish: no sale</button> : null}
          {visit.status === 'arrived' && sales > 0 ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void go(finishVisitAction({ dayId, id: visit.id, outcome: 'sold' }), `The visit to ${name} is finished.`)} aria-label={`Finish the visit to ${name}`}>Finish the visit</button> : null}
          {visit.status === 'planned' ? <button type="button" className={buttonClass} onClick={() => setMode('skip')} aria-label={`Skip ${name}`}>Skip</button> : null}
          <InlineConfirm label={`${name}'s shop is closed`} action="Shop closed" confirm="Yes, it is shut" busy={busy} onConfirm={() => void go(closedShopAction({ dayId, id: visit.id }), `${name}'s shop was found closed.`)} />
        </div>
      ) : null}
      {mode === 'return' && returnable.length > 0 ? <ReturnForm screen={screen} sales={returnable} visitId={visit.id} customer={name} run={run} onDone={() => setMode('view')} onCancel={() => setMode('view')} /> : null}
      {mode === 'collect' && owing !== undefined ? <CollectForm screen={screen} owing={owing} customer={name} run={run} onDone={() => setMode('view')} onCancel={() => setMode('view')} /> : null}
      {mode === 'order' ? <SellForm screen={screen} visitId={visit.id} customer={name} mode="order" usual={screen.usual.find((u) => u.visitId === visit.id)} run={run} onDone={() => setMode('view')} onCancel={() => setMode('view')} /> : null}
      {mode === 'sell' ? <SellForm screen={screen} visitId={visit.id} customer={name} mode="sell" usual={screen.usual.find((u) => u.visitId === visit.id)} run={run} onDone={() => setMode('view')} onCancel={() => setMode('view')} /> : null}
      {mode === 'skip' ? <WhyPanel label={`Skip ${name}`} action="Skip this customer" busy={busy} onCancel={() => setMode('view')} onConfirm={(reason) => void go(skipVisitAction({ dayId, id: visit.id, reason }), `${name} is skipped.`)} /> : null}
      {mode === 'finish' ? <WhyPanel label={`Finish ${name}`} action="Finish the visit" busy={busy} onCancel={() => setMode('view')} onConfirm={(reason) => void go(finishVisitAction({ dayId, id: visit.id, outcome: 'no_sale', reason }), `The visit to ${name} is finished with no sale.`)} /> : null}
    </div>
  );
}
