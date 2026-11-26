'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { arriveAction, type DayScreen, type dayScreenAction } from '@/server/domains/van-sales/actions';
import { Chip, LoadFailed, Message, attempt, cardClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { currentPosition } from '@/lib/browser-position';
import { kes } from '@/lib/till/tile-style';
import { progressPercent, progressWords } from '@/lib/van-sales/rep-labels';
import { ROUTE_MODE_WORDS } from '@/lib/van-sales/settings';
import { ContactLinks } from '@/components/admin/van-sales/day/ContactLinks';
import { CashPanel } from '@/components/admin/van-sales/day/CashPanel';
import { DropsPanel } from '@/components/admin/van-sales/day/DropsPanel';
import { EndPanel } from '@/components/admin/van-sales/day/EndPanel';
import { HistoryPanel } from '@/components/admin/van-sales/day/HistoryPanel';
import { LoadPanel } from '@/components/admin/van-sales/day/LoadPanel';
import { RunPanel } from '@/components/admin/van-sales/day/RunPanel';
import { SettlePanel } from '@/components/admin/van-sales/day/SettlePanel';
import { SalesPanel } from '@/components/admin/van-sales/day/SalesPanel';
import { VisitsPanel } from '@/components/admin/van-sales/day/VisitsPanel';
import type { DayCall } from '@/components/admin/van-sales/day/call';

type Loaded = Awaited<ReturnType<typeof dayScreenAction>>;
const TONE = { planned: 'sky', loading: 'amber', out: 'green', returning: 'amber', reconciling: 'amber', closed: 'gray', cancelled: 'gray' } as const;

export function RepDayClient({ viewPromise }: { viewPromise: ReturnType<typeof dayScreenAction> }) {
  const res: Loaded = use(viewPromise);
  return res.ok ? <Body initial={res.data} /> : <LoadFailed error={res.error} />;
}

function Body({ initial }: { initial: DayScreen }) {
  const [screen, setScreen] = useState(initial);
  const [notice, setNotice] = useState<Notice>(null);
  const run: DayCall = async (call, okText) => {
    setNotice(null);
    const r = await attempt(call);
    if (r.ok) {
      setScreen(r.data);
      setNotice({ kind: 'ok', text: typeof okText === 'function' ? okText(r.data) : okText });
      return null;
    }
    setNotice({ kind: 'error', text: r.error });
    return r.error;
  };
  const { day, visits } = screen.detail;
  const done = visits.filter((v) => v.status === 'done' || v.status === 'skipped' || v.status === 'closed_shop').length;
  return (
    <>
      <p className="text-sm"><Link href="/rep" className="inline-flex min-h-11 items-center text-indigo-600 underline">My days</Link></p>
      <section className={`${cardClass} space-y-3`} aria-label="The day">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-bold text-fg-strong">{day.number}</h1>
          <Chip tone={TONE[day.status]}>{day.statusWords}</Chip>
        </div>
        <p className="text-sm text-fg-muted">{day.date} · {day.routeName} · {ROUTE_MODE_WORDS[day.mode]}{day.vanName === null ? '' : ` · van ${day.vanName}`}</p>
        <div className="space-y-1">
          <p className="text-sm text-fg-strong">{progressWords(done, visits.length)}</p>
          <div className="h-2 overflow-hidden rounded-full bg-surface-sunken" aria-hidden><div className="h-full rounded-full bg-indigo-600" style={{ width: `${String(progressPercent(done, visits.length))}%` }} /></div>
        </div>
        {screen.cash === null ? null : <p className="text-sm text-fg-muted">Cash on the van <span className="font-mono font-semibold text-fg-strong">{kes(screen.cash.cash)}</span></p>}
      </section>
      <Message notice={notice} />
      <RunPanel screen={screen} run={run} />
      <EndPanel screen={screen} run={run} />
      <SettlePanel screen={screen} run={run} />
      <NextStop screen={screen} run={run} />
      <VisitsPanel screen={screen} run={run} nextStopId={nextStopOf(screen)?.id} />
      <SalesPanel screen={screen} />
      <DropsPanel screen={screen} run={run} />
      <CashPanel screen={screen} run={run} />
      <LoadPanel screen={screen} run={run} />
      <HistoryPanel events={screen.detail.events} />
    </>
  );
}

/** The customer to see next while the day is out and the signed-in person is the rep: the one they are at, or else the first still to visit. */
function nextStopOf(screen: DayScreen) {
  if (screen.detail.day.status !== 'out' || !screen.isRep) return undefined;
  return screen.detail.visits.find((v) => v.status === 'arrived') ?? screen.detail.visits.find((v) => v.status === 'planned');
}

/** The customer to see next while the day is out: who and where, ways to reach them, and a large Arrive when the rep is there. */
function NextStop({ screen, run }: { screen: DayScreen; run: DayCall }) {
  const [busy, setBusy] = useState(false);
  const { day } = screen.detail;
  const visit = nextStopOf(screen);
  if (visit === undefined) return null;
  const arrive = async () => {
    setBusy(true);
    const position = await currentPosition();
    await run(arriveAction({ dayId: day.id, id: visit.id, position, deviceTime: new Date().toISOString() }), `You are at ${visit.customerName}.`);
    setBusy(false);
  };
  return (
    <section className={`${cardClass} space-y-3 border-indigo-500/40`} aria-label="Next stop">
      <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">{visit.status === 'arrived' ? 'You are at' : 'Next stop'}</p>
      <div>
        <p className="text-lg font-bold text-fg-strong">{visit.customerName}</p>
        {visit.customerPlace === null ? null : <p className="text-sm text-fg-muted">{visit.customerPlace}</p>}
        {visit.customerWarning === null ? null : <p className="mt-1"><Chip tone="amber">{visit.customerWarning}</Chip></p>}
      </div>
      <ContactLinks visit={visit} />
      {visit.status === 'planned' ? <button type="button" className={`${primaryClass} min-h-12 w-full text-base`} disabled={busy} onClick={() => void arrive()} aria-label={`I am at ${visit.customerName}`}>{busy ? 'Arriving…' : 'I am here'}</button> : <p className="text-sm text-fg-muted">Sell, take an order, collect or return below.</p>}
    </section>
  );
}
