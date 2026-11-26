'use client';

import { useId, useState } from 'react';
import { approveLoadAction, cancelLoadAction, receiveUnloadAction, shipLoadAction, signLoadAction, type DayScreen } from '@/server/domains/van-sales/actions';
import type { LoadView } from '@/server/domains/van-sales/loads';
import { WhyPanel } from '../WhyPanel';
import { Chip, Field, buttonClass, cardClass, fieldClass, primaryClass } from '@/components/ui/screen-kit';
import { useWhen } from '@/components/business-time';
import { LOAD_KIND_WORDS } from '@/lib/van-sales/load';
import type { DayCall } from './call';

const TONE: Record<string, 'sky' | 'amber' | 'green' | 'gray'> = { requested: 'sky', approved: 'sky', shipped: 'amber', partly_received: 'amber', received: 'green', closed: 'gray', cancelled: 'gray' };

/** One load or top-up: where it has got to, what is in it, and the one step that is next. */
export function LoadCard({ load, screen, run }: { load: LoadView; screen: DayScreen; run: DayCall }) {
  const when = useWhen();
  const [mode, setMode] = useState<'view' | 'sign' | 'receive' | 'cancel'>('view');
  const [busy, setBusy] = useState(false);
  const dayId = load.dayId;
  const may = screen.canPlan;
  const unloading = load.kind === 'unload';
  const maySign = load.steps.sign && !unloading && (screen.isRep ? screen.maySell : screen.canPlan);
  const mayReceive = load.steps.sign && unloading && screen.mayReconcile;
  const go = async (call: ReturnType<typeof shipLoadAction>, text: string) => {
    setBusy(true);
    await run(call, text);
    setBusy(false);
  };
  return (
    <li className={`${cardClass} space-y-3`}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 basis-48 text-sm font-bold text-fg-strong">{LOAD_KIND_WORDS[load.kind]} <span className="font-mono text-xs font-normal text-fg-muted">{load.number}</span></p>
        <Chip tone={TONE[load.state] ?? 'gray'}>{load.stateWords}</Chip>
      </div>
      <p className="text-xs text-fg-muted">{unloading ? `From the van, ${load.fromName}` : `From ${load.fromName}`} · asked for {when(load.createdAt)}</p>
      <ul className="space-y-1 text-sm" aria-label={`Lines of ${load.number}`}>
        {load.lines.map((l) => (
          <li key={l.productId} className="flex flex-wrap gap-x-3">
            <span className="font-semibold">{l.productName}</span>{' '}
            <span className="text-fg-muted">asked {l.asked}{load.state === 'requested' || load.state === 'approved' ? '' : ` · sent ${String(l.shipped)} · ${unloading ? 'received' : 'signed for'} ${String(l.received)}`}{l.inTransit > 0 ? ` · ${String(l.inTransit)} ${unloading && load.signedAt !== null ? 'missing' : 'still on its way'}` : ''}</span>
          </li>
        ))}
      </ul>
      {load.signedAt === null ? null : (
        <p className="text-sm text-fg-muted" data-testid="load-signed">
          {unloading ? 'Received' : 'Signed for'} {when(load.signedAt)} by {load.signedByName ?? 'the rep'}{load.signedOnBehalf ? ` on the rep's behalf: ${load.signReason ?? ''}` : ''}.
        </p>
      )}
      {load.cancelledAt === null ? null : <p className="text-sm text-fg-muted">Called off because: {load.cancelReason ?? ''}</p>}
      {mode === 'view' ? (
        <div className="flex flex-wrap gap-2">
          {may && load.steps.approve ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void go(approveLoadAction({ dayId, id: load.id }), `${load.number} is approved.`)}>Approve</button> : null}
          {may && load.steps.ship ? <button type="button" className={primaryClass} disabled={busy} onClick={() => void go(shipLoadAction({ dayId, id: load.id }), `${load.number} has left the warehouse and is on its way to the van.`)}>Send it</button> : null}
          {maySign ? <button type="button" className={primaryClass} onClick={() => setMode('sign')}>Sign for the load</button> : null}
          {mayReceive ? <button type="button" className={primaryClass} onClick={() => setMode('receive')}>Receive at the warehouse</button> : null}
          {may && load.steps.cancel ? <button type="button" className={buttonClass} onClick={() => setMode('cancel')}>Call it off</button> : null}
        </div>
      ) : null}
      {mode === 'sign' ? <SignForm load={load} screen={screen} run={run} onDone={() => setMode('view')} /> : null}
      {mode === 'receive' ? <ReceiveForm load={load} run={run} onDone={() => setMode('view')} /> : null}
      {mode === 'cancel' ? <WhyPanel label={`Call off ${load.number}`} action="Call the load off" busy={busy} onCancel={() => setMode('view')} onConfirm={(reason) => void go(cancelLoadAction({ dayId, id: load.id, reason }), `${load.number} is called off.`).then(() => setMode('view'))} /> : null}
    </li>
  );
}

/** Counting what arrived on the van: everything that was sent unless the rep says otherwise. The office signing for the rep gives a reason. */
function SignForm({ load, screen, run, onDone }: { load: LoadView; screen: DayScreen; run: DayCall; onDone: () => void }) {
  const uid = useId();
  const [counts, setCounts] = useState<Record<string, string>>(() => Object.fromEntries(load.lines.filter((l) => l.inTransit > 0).map((l) => [l.productId, String(l.inTransit)])));
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const onBehalf = !screen.isRep;
  const save = async () => {
    setBusy(true);
    setProblem(null);
    const entries = Object.entries(counts).map(([productId, q]) => ({ productId, quantity: Number(q) }));
    const answer = await run(signLoadAction({ dayId: load.dayId, id: load.id, entries, reason: why }), `${load.number} is signed for. The stock is on the van.`);
    setBusy(false);
    if (answer === null) onDone();
    else setProblem(answer);
  };
  return (
    <form aria-label={`Sign for ${load.number}`} className="space-y-3 rounded-lg border border-line bg-surface-sunken p-3" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <p className="text-sm text-fg-muted">Count what arrived on the van. If something did not arrive, put what you counted: the rest stays on its way to be settled under Stock › Transfers.</p>
      {load.lines.filter((l) => l.inTransit > 0).map((l) => (
        <label key={l.productId} className="flex flex-wrap items-center gap-3 text-sm">
          <span className="min-w-0 flex-1 basis-48 font-semibold">{l.productName} <span className="font-normal text-fg-muted">(sent {l.inTransit})</span></span>
          <span className="sr-only">Counted {l.productName}</span>
          <input className={`${fieldClass} w-28`} inputMode="decimal" value={counts[l.productId] ?? ''} onChange={(e) => setCounts((cur) => ({ ...cur, [l.productId]: e.target.value }))} autoComplete="off" />
        </label>
      ))}
      {onBehalf ? (
        <Field id={`${uid}-why`} label="Why are you signing for the rep?" hint="For example: the rep signed the paper copy at the depot">
          <input id={`${uid}-why`} className={fieldClass} value={why} onChange={(e) => setWhy(e.target.value)} maxLength={300} autoComplete="off" />
        </Field>
      ) : null}
      {problem === null ? null : <p role="alert" className="text-sm text-red-700">{problem}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={primaryClass} disabled={busy}>{busy ? 'Signing…' : 'Sign for it'}</button>
        <button type="button" className={buttonClass} onClick={onDone} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}

/** Counting what came off the van at the warehouse: everything that was sent unless the warehouse says otherwise. What was not counted stays on its way as a shortage to decide. */
function ReceiveForm({ load, run, onDone }: { load: LoadView; run: DayCall; onDone: () => void }) {
  const [counts, setCounts] = useState<Record<string, string>>(() => Object.fromEntries(load.lines.filter((l) => l.inTransit > 0).map((l) => [l.productId, String(l.inTransit)])));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setProblem(null);
    const entries = Object.entries(counts).map(([productId, q]) => ({ productId, quantity: Number(q) }));
    const answer = await run(receiveUnloadAction({ dayId: load.dayId, id: load.id, entries }), `${load.number} is received at the warehouse.`);
    setBusy(false);
    if (answer === null) onDone();
    else setProblem(answer);
  };
  return (
    <form aria-label={`Receive ${load.number}`} className="space-y-3 rounded-lg border border-line bg-surface-sunken p-3" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <p className="text-sm text-fg-muted">Count what came off the van. If something is missing, put what you counted: the rest is a shortage to decide when the day is settled.</p>
      {load.lines.filter((l) => l.inTransit > 0).map((l) => (
        <label key={l.productId} className="flex flex-wrap items-center gap-3 text-sm">
          <span className="min-w-0 flex-1 basis-48 font-semibold">{l.productName} <span className="font-normal text-fg-muted">(sent {l.inTransit})</span></span>
          <span className="sr-only">Counted {l.productName}</span>
          <input className={`${fieldClass} w-28`} inputMode="decimal" value={counts[l.productId] ?? ''} onChange={(e) => setCounts((cur) => ({ ...cur, [l.productId]: e.target.value }))} autoComplete="off" />
        </label>
      ))}
      {problem === null ? null : <p role="alert" className="text-sm text-red-700">{problem}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={primaryClass} disabled={busy}>{busy ? 'Receiving…' : 'Receive it'}</button>
        <button type="button" className={buttonClass} onClick={onDone} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}
