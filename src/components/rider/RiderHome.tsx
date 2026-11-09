'use client';

import { use, useEffect } from 'react';
import Link from 'next/link';
import type { myRunsAction } from '@/server/domains/delivery/rider-app-actions';
import type { RiderRunItem } from '@/server/domains/delivery/rider-runs';
import { Chip } from '@/components/ui/screen-kit';
import type { RunStatus } from '@/lib/dispatch-run';
import { OfflineBar } from './OfflineBar';
import { keepRunScreen } from './RegisterWorker';

const TONE: Record<RunStatus, 'green' | 'amber' | 'red' | 'sky' | 'gray'> = { planned: 'sky', started: 'amber', completed: 'green', cancelled: 'gray' };

/** The rider's runs: what is still to do, then the last few finished. */
export function RiderHome({ runsPromise }: { runsPromise: ReturnType<typeof myRunsAction> }) {
  const res = use(runsPromise);
  if (!res.ok) {
    return (
      <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
        {res.error}
      </p>
    );
  }
  return <Home data={res.data} />;
}

function Home({ data }: { data: Extract<Awaited<ReturnType<typeof myRunsAction>>, { ok: true }>['data'] }) {
  const { self, open, recent, held } = data;
  const keep = open.map((r) => r.id).join(',');
  // The runs still to do are kept on the phone while there is signal, so each can be opened without it later.
  useEffect(() => {
    for (const id of keep === '' ? [] : keep.split(',')) keepRunScreen(id);
  }, [keep]);
  return (
    <div className="space-y-5">
      <OfflineBar riderId={self.id} />
      <div>
        <h1 className="text-xl font-bold text-fg-strong">Hello, {self.name}</h1>
        <p className="text-sm text-fg-muted">Your runs are below.</p>
      </div>
      {Number(held) > 0 ? (
        <p role="status" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          You are holding <strong>KSh {held}</strong> in cash collected at doors. Hand it in to the shop.
        </p>
      ) : null}
      <Link href="/rider/pay" className="flex min-h-12 items-center justify-between gap-3 rounded-xl border border-line bg-surface-raised p-4 text-sm font-semibold text-fg-strong">
        <span>My pay</span>
        <span aria-hidden="true">→</span>
      </Link>
      <RunList title="To do" runs={open} empty="You have no run to do. When the shop gives you one, it shows here." />
      {recent.length > 0 ? <RunList title="Finished lately" runs={recent} empty="" /> : null}
    </div>
  );
}

function RunList({ title, runs, empty }: { title: string; runs: RiderRunItem[]; empty: string }) {
  return (
    <section aria-label={title} className="space-y-2">
      <h2 className="text-sm font-bold text-fg-strong">{title}</h2>
      {runs.length === 0 ? (
        <p role="status" className="rounded-xl border border-line bg-surface-raised p-5 text-center text-sm text-fg-muted">
          {empty}
        </p>
      ) : (
        <ul className="space-y-2">
          {runs.map((r) => (
            <li key={r.id}>
              <Link href={`/rider/runs/${r.id}`} className="flex min-h-14 items-center justify-between gap-3 rounded-xl border border-line bg-surface-raised p-4">
                <span className="min-w-0">
                  <span className="block font-mono text-sm font-semibold text-indigo-600 dark:text-indigo-400">{r.number}</span>
                  <span className="block text-xs text-fg-muted">
                    {r.runDate} · from {r.branchName} · {r.stops} {r.stops === 1 ? 'stop' : 'stops'}
                  </span>
                </span>
                <Chip tone={TONE[r.status]}>{r.statusWords}</Chip>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
