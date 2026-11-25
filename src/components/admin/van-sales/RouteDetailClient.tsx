'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { setRouteActiveAction, type RouteScreen, type routeScreenAction } from '@/server/domains/van-sales/actions';
import { Chip, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, type Notice } from '@/components/ui/screen-kit';
import { ROUTE_MODE_WORDS } from '@/lib/van-sales/settings';
import { WhyPanel } from './WhyPanel';
import type { RouteCall } from './route/call';
import { DuePanel } from './route/DuePanel';
import { ParPanel } from './route/ParPanel';
import { RouteForm } from './route/RouteForm';
import { StopsPanel } from './route/StopsPanel';

type Loaded = Awaited<ReturnType<typeof routeScreenAction>>;

export function RouteDetailClient({ viewPromise }: { viewPromise: ReturnType<typeof routeScreenAction> }) {
  const res: Loaded = use(viewPromise);
  return res.ok ? <Body initial={res.data} /> : <LoadFailed error={res.error} />;
}

function Body({ initial }: { initial: RouteScreen }) {
  const [screen, setScreen] = useState(initial);
  const [notice, setNotice] = useState<Notice>(null);
  const [mode, setMode] = useState<'view' | 'edit' | 'stop'>('view');
  const [busy, setBusy] = useState(false);
  /** Runs one change, shows the route as it now is, and says in words what happened or why not. */
  const run: RouteCall = async (call, okText) => {
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
  const r = screen.route;
  const stopped = r.status === 'stopped';
  const change = async (call: ReturnType<typeof setRouteActiveAction>, text: string) => {
    setBusy(true);
    const answer = await run(call, text);
    setBusy(false);
    if (answer === null) setMode('view');
  };
  return (
    <div className="max-w-5xl space-y-5">
      <p className="text-sm"><Link href="/admin/van-sales/routes" className="text-indigo-600 underline">All routes</Link></p>
      <PageHeader title={r.name} intro={`Route ${r.code}. ${ROUTE_MODE_WORDS[r.mode]}, from ${r.branchName}.`} />
      <Message notice={notice} />
      <section className={`${cardClass} space-y-3`} aria-label="The route">
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone={stopped ? 'gray' : 'green'}>{stopped ? 'Stopped' : 'In use'}</Chip>
          <Chip tone="sky">{ROUTE_MODE_WORDS[r.mode]}</Chip>
          <span className="text-sm text-fg-muted">
            {r.defaultVanName === null ? 'No usual van' : `Van ${r.defaultVanName}`} · {r.defaultRepName === null ? 'No usual rep' : `Rep ${r.defaultRepName}`}
          </span>
        </div>
        {stopped && r.statusReason !== null ? <p className="text-sm text-fg-muted">Stopped because: {r.statusReason}</p> : null}
        {screen.canManage && mode === 'view' ? (
          <div className="flex flex-wrap gap-2">
            {stopped ? null : <button type="button" className={buttonClass} onClick={() => setMode('edit')}>Change the route</button>}
            {stopped ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void change(setRouteActiveAction({ id: r.id, active: true, expectedVersion: r.version }), `${r.name} is in use again.`)}>Use again</button> : <button type="button" className={buttonClass} onClick={() => setMode('stop')}>Stop this route</button>}
          </div>
        ) : null}
        {mode === 'edit' ? <RouteForm route={r} modes={screen.modes} onCancel={() => setMode('view')} onSaved={(saved) => { setMode('view'); if ('route' in saved) setScreen(saved); setNotice({ kind: 'ok', text: `${r.name} saved.` }); }} /> : null}
        {mode === 'stop' ? <WhyPanel label={`Stop ${r.name}`} action="Stop the route" busy={busy} onCancel={() => setMode('view')} onConfirm={(reason) => void change(setRouteActiveAction({ id: r.id, active: false, reason, expectedVersion: r.version }), `${r.name} is stopped.`)} /> : null}
      </section>
      <StopsPanel screen={screen} run={run} />
      <ParPanel screen={screen} run={run} />
      <DuePanel screen={screen} />
    </div>
  );
}
