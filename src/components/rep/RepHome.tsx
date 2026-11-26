'use client';

import Link from 'next/link';
import { use } from 'react';
import { Chip, LoadFailed, cardClass } from '@/components/ui/screen-kit';
import { dayLabel, progressPercent, progressWords } from '@/lib/van-sales/rep-labels';
import type { myDaysAction } from '@/server/domains/van-sales/actions';

type Loaded = Awaited<ReturnType<typeof myDaysAction>>;
const TONE = { planned: 'sky', loading: 'amber', out: 'green', returning: 'amber', reconciling: 'amber', closed: 'gray', cancelled: 'gray' } as const;

/** The home of the rep app: the days that are theirs to run, the one under way first, each a large tap target. */
export function RepHome({ daysPromise }: { daysPromise: ReturnType<typeof myDaysAction> }) {
  const res: Loaded = use(daysPromise);
  if (!res.ok) return <LoadFailed error={res.error} />;
  if (res.data === null) {
    return (
      <section className={cardClass} aria-label="Not a sales rep">
        <h1 className="text-lg font-bold text-fg-strong">You are not set up as a sales rep</h1>
        <p className="mt-1 text-sm text-fg-muted">Ask the office to add you under Sales, Van sales, Sales reps.</p>
      </section>
    );
  }
  const { repName, today, days } = res.data;
  return (
    <>
      <h1 className="text-lg font-bold text-fg-strong">{repName}</h1>
      {days.length === 0 ? (
        <p role="status" className="rounded-xl border border-line bg-surface-raised p-6 text-center text-sm text-fg-muted">No day is planned for you this week.</p>
      ) : (
        <ul className="space-y-3" aria-label="Your days">
          {days.map((d) => (
            <li key={d.id}>
              <Link href={`/rep/days/${d.id}`} className="block min-h-14 space-y-2 rounded-xl border border-line bg-surface-raised p-4 active:bg-surface" aria-label={`${dayLabel(d.date, today)}, ${d.routeName}`}>
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-base font-bold text-fg-strong">{dayLabel(d.date, today)}</span>
                  <Chip tone={TONE[d.status]}>{d.statusWords}</Chip>
                </span>
                <span className="block text-sm text-fg-strong">{d.routeName}</span>
                <span className="block text-xs text-fg-muted">{d.number} · {d.modeWords}{d.vanName === null ? '' : ` · van ${d.vanName}`}</span>
                <span className="block space-y-1">
                  <span className="block text-xs text-fg-muted">{progressWords(d.visitsDone, d.visits)}</span>
                  <span className="block h-1.5 overflow-hidden rounded-full bg-surface-sunken" aria-hidden><span className="block h-full rounded-full bg-indigo-600" style={{ width: `${String(progressPercent(d.visitsDone, d.visits))}%` }} /></span>
                </span>
                {d.next === null ? null : <span className="block text-sm"><span className="text-fg-muted">Next: </span><span className="font-semibold text-fg-strong">{d.next}</span></span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
