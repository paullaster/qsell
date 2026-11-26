'use client';

import { useState } from 'react';
import { closeDayAction, closeVanTillAction, decideShortageAction, type DayScreen } from '@/server/domains/van-sales/actions';
import type { ShortageView } from '@/server/domains/van-sales/settle';
import { Chip, buttonClass, cardClass, primaryClass } from '@/components/ui/screen-kit';
import { kes } from '@/lib/till/tile-style';
import { RULE_WORDS } from '@/lib/van-sales/settle';
import { WhyPanel } from '../WhyPanel';
import type { DayCall } from './call';

const inputClass = 'min-h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm';

/** Settling the day: the shortages found at the unload, the van's till counted and closed, and the day closed. Each step says what is in its way. */
export function SettlePanel({ screen, run }: { screen: DayScreen; run: DayCall }) {
  const settle = screen.settle;
  const { day } = screen.detail;
  if (settle === null) return null;
  const closed = day.status === 'closed';
  return (
    <section className={`${cardClass} space-y-4`} aria-label="Settling the day">
      <h2 className="text-base font-bold text-fg-strong">{closed ? 'The day is closed' : 'Settling the day'}</h2>
      {settle.shortages.length === 0 ? null : (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-fg-strong">Shortages</h3>
          <ul className="space-y-2" aria-label="Shortages">
            {settle.shortages.map((s) => <ShortageRow key={s.id} shortage={s} screen={screen} run={run} />)}
          </ul>
        </div>
      )}
      {day.vanId === null || settle.till.status === null ? null : <TillSection screen={screen} run={run} />}
      {closed ? null : <CloseDay screen={screen} run={run} />}
    </section>
  );
}

function ShortageRow({ shortage: s, screen, run }: { shortage: ShortageView; screen: DayScreen; run: DayCall }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const dayId = screen.detail.day.id;
  const mayDecide = screen.detail.day.status === 'reconciling' && screen.mayReconcile && !screen.isRep && (!s.needsApproval || screen.mayApprove);
  return (
    <li className="space-y-2 rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 basis-40 text-sm"><span className="font-semibold text-fg-strong">{s.productName}</span> <span className="text-fg-muted">{s.quantity} missing · {kes(s.value)} at cost</span></span>
        {s.decided ? <Chip tone="gray">{s.decision === 'charge_rep' ? 'Written off, charged to the rep' : 'Written off'}</Chip> : <Chip tone="amber">To decide</Chip>}
      </div>
      {s.decided ? <p className="text-xs text-fg-muted">{s.reason}{s.decidedByName === null ? '' : ` · ${s.decidedByName}`}{s.chargedAmount === null ? '' : ` · ${kes(s.chargedAmount)} charged`}</p> : null}
      {!s.decided && screen.isRep ? <p className="text-xs text-fg-muted">The office decides the shortages of your van.</p> : null}
      {!s.decided && !screen.isRep && !mayDecide && s.needsApproval ? <p className="text-xs text-fg-muted">A manager decides this one: it is worth more than the company&apos;s limit.</p> : null}
      {!s.decided && mayDecide && !open ? <button type="button" className={buttonClass} onClick={() => setOpen(true)} aria-label={`Decide the shortage of ${s.productName}`}>Decide</button> : null}
      {open ? (
        <WhyPanel label={`Decide ${s.productName}`} action={RULE_WORDS[s.rule]} busy={busy} onCancel={() => setOpen(false)} onConfirm={(reason) => void (async () => {
          setBusy(true);
          const answer = await run(decideShortageAction({ dayId, id: s.id, reason }), `${s.productName} is written off.`);
          setBusy(false);
          if (answer === null) setOpen(false);
        })()} />
      ) : null}
    </li>
  );
}

function TillSection({ screen, run }: { screen: DayScreen; run: DayCall }) {
  const [counted, setCounted] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const settle = screen.settle;
  if (settle === null) return null;
  const { till } = settle;
  const mayClose = screen.detail.day.status === 'reconciling' && screen.mayCloseTill && till.status === 'open';
  const submit = async () => {
    setBusy(true);
    setProblem(null);
    const answer = await run(closeVanTillAction({ dayId: screen.detail.day.id, counted, reason }), 'The till is counted and closed.');
    setBusy(false);
    if (answer !== null) setProblem(answer);
  };
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-fg-strong">The van&apos;s till</h3>
      {till.status === 'closed' ? <p className="text-sm text-fg-muted" data-testid="till-closed">Counted and closed{till.zNumber === null ? '' : `, report ${till.zNumber}`}{till.variance === null || till.variance === 0 ? '' : `, ${till.variance > 0 ? 'over' : 'short'} by ${kes(Math.abs(till.variance))}`}.</p> : null}
      {till.status === 'closing' ? <p className="text-sm text-fg-muted">The close is waiting for approval.</p> : null}
      {mayClose ? (
        <form aria-label="Count the till" className="space-y-3 rounded-lg border border-line bg-surface-sunken p-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <label className="block text-xs text-fg-muted">Cash counted in the till (KES)
            <input className={inputClass} inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} aria-label="Cash counted in the till" />
          </label>
          <label className="block text-xs text-fg-muted">Reason, if the count differs from what the till should hold (optional)
            <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} aria-label="Reason for a difference in the till" />
          </label>
          {problem === null ? null : <p role="alert" className="text-sm text-red-700">{problem}</p>}
          <button type="submit" className={primaryClass} disabled={busy || counted.trim() === ''}>{busy ? 'Closing…' : 'Close the till'}</button>
        </form>
      ) : null}
    </div>
  );
}

function CloseDay({ screen, run }: { screen: DayScreen; run: DayCall }) {
  const [busy, setBusy] = useState(false);
  const settle = screen.settle;
  if (settle === null || !screen.mayReconcile) return null;
  return (
    <div className="space-y-2">
      {settle.closeProblem === null ? null : <p className="text-sm text-fg-muted" data-testid="close-problem">{settle.closeProblem}</p>}
      <button type="button" className={`${primaryClass} min-h-11`} disabled={busy || settle.closeProblem !== null} onClick={() => void (async () => { setBusy(true); await run(closeDayAction({ dayId: screen.detail.day.id }), 'The day is closed.'); setBusy(false); })()}>Close the day</button>
    </div>
  );
}
