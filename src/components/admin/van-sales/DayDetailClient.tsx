'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { cancelDayAction, type DayScreen, type dayScreenAction } from '@/server/domains/van-sales/actions';
import { Chip, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, type Notice } from '@/components/ui/screen-kit';
import { canMoveDay } from '@/lib/van-sales/days';
import { ROUTE_MODE_WORDS } from '@/lib/van-sales/settings';
import { WhyPanel } from './WhyPanel';
import type { DayCall } from './day/call';
import { HistoryPanel } from './day/HistoryPanel';
import { RunPanel } from './day/RunPanel';
import { LoadPanel } from './day/LoadPanel';
import { VisitsPanel } from './day/VisitsPanel';

type Loaded = Awaited<ReturnType<typeof dayScreenAction>>;
const TONE = { planned: 'sky', loading: 'amber', out: 'green', returning: 'amber', reconciling: 'amber', closed: 'gray', cancelled: 'gray' } as const;

export function DayDetailClient({ viewPromise }: { viewPromise: ReturnType<typeof dayScreenAction> }) {
  const res: Loaded = use(viewPromise);
  return res.ok ? <Body initial={res.data} /> : <LoadFailed error={res.error} />;
}

function Body({ initial }: { initial: DayScreen }) {
  const [screen, setScreen] = useState(initial);
  const [notice, setNotice] = useState<Notice>(null);
  const [cancelling, setCancelling] = useState(false);
  const [busy, setBusy] = useState(false);
  const run: DayCall = async (call, okText) => {
    setNotice(null);
    const r = await attempt(call);
    if (r.ok) {
      setScreen(r.data);
      setNotice({ kind: 'ok', text: okText });
      return null;
    }
    setNotice({ kind: 'error', text: r.error });
    return r.error;
  };
  const { day, events } = screen.detail;
  const mayCancel = screen.canPlan && canMoveDay(day.status, 'cancelled');
  const cancel = async (reason: string) => {
    setBusy(true);
    const answer = await run(cancelDayAction({ id: day.id, reason, expectedVersion: day.version }), `${day.number} is cancelled.`);
    setBusy(false);
    if (answer === null) setCancelling(false);
  };
  return (
    <div className="max-w-5xl space-y-5">
      <p className="text-sm"><Link href="/admin/van-sales/days" className="text-indigo-600 underline">All van days</Link></p>
      <PageHeader title={day.number} intro={`${day.date} · ${day.routeName} (${day.routeCode}), from ${day.branchName}.`} />
      <Message notice={notice} />
      <section className={`${cardClass} space-y-3`} aria-label="The day">
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone={TONE[day.status]}>{day.statusWords}</Chip>
          <Chip tone="sky">{ROUTE_MODE_WORDS[day.mode]}</Chip>
          <span className="text-sm text-fg-muted">Rep {day.repName} · {day.vanName === null ? 'no van' : `van ${day.vanName}`}</span>
          <Link href={`/admin/van-sales/routes/${day.routeId}`} className="text-sm text-indigo-600 underline">Open the route</Link>
        </div>
        {day.status === 'cancelled' && day.statusReason !== null ? <p className="text-sm text-fg-muted">Cancelled because: {day.statusReason}</p> : null}
        {mayCancel && !cancelling ? <button type="button" className={buttonClass} onClick={() => setCancelling(true)}>Cancel this day</button> : null}
        {cancelling ? <WhyPanel label={`Cancel ${day.number}`} action="Cancel the day" busy={busy} onCancel={() => setCancelling(false)} onConfirm={(reason) => void cancel(reason)} /> : null}
      </section>
      <RunPanel screen={screen} run={run} />
      <VisitsPanel screen={screen} run={run} />
      <LoadPanel screen={screen} run={run} />
      <HistoryPanel events={events} />
    </div>
  );
}
