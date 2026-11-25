'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useId, useState } from 'react';
import { daysPageAction, type DaysPage } from '@/server/domains/van-sales/actions';
import type { DayView } from '@/server/domains/van-sales/days';
import { useDebouncedValue } from '@/components/ui/useDebouncedValue';
import { usePagedList } from '@/components/ui/usePagedList';
import { Chip, LoadFailed, PageHeader, buttonClass, cardClass, fieldClass, primaryClass } from '@/components/ui/screen-kit';
import { vanSalesOn, ROUTE_MODE_WORDS } from '@/lib/van-sales/settings';
import { PlanForm } from './day/PlanForm';

type Loaded = Awaited<ReturnType<typeof daysPageAction>>;
type Filter = 'open' | 'closed' | 'cancelled' | 'all';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'closed', label: 'Closed' },
  { id: 'cancelled', label: 'Cancelled' },
  { id: 'all', label: 'All' },
];
const TONE = { planned: 'sky', loading: 'amber', out: 'green', returning: 'amber', reconciling: 'amber', closed: 'gray', cancelled: 'gray' } as const;

export function DaysClient({ firstPromise }: { firstPromise: ReturnType<typeof daysPageAction> }) {
  const res: Loaded = use(firstPromise);
  return res.ok ? <Body first={res.data} /> : <LoadFailed error={res.error} />;
}

function Body({ first }: { first: DaysPage }) {
  const uid = useId();
  const router = useRouter();
  const [status, setStatus] = useState<Filter>('open');
  const [text, setText] = useState('');
  const query = useDebouncedValue(text.trim(), 300);
  const [planning, setPlanning] = useState(false);
  const list = usePagedList<DayView, { query: string; status: Filter }>({
    load: (f, cursor) => daysPageAction({ query: f.query, status: f.status, cursor }),
    filters: { query, status },
    initialPage: { ok: true, data: { rows: first.rows, nextCursor: first.nextCursor } },
  });
  const on = vanSalesOn(first.modes);
  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title="Van days"
        intro="A van day is one rep's outing on one route on one date. Plan a day and the customers due that day are put on it, in the order of the round."
        actions={first.canPlan && on && !planning ? <button type="button" className={primaryClass} onClick={() => setPlanning(true)}>Plan a day</button> : null}
      />
      {on ? null : (
        <p role="status" className={`${cardClass} text-sm text-fg-muted`} data-testid="days-off">
          Neither van selling nor pre-selling is switched on, so days cannot be planned yet. Switch one on in Settings › Sales › Van sales.
        </p>
      )}
      {planning ? (
        <section className={`${cardClass} space-y-3`} aria-label="Plan a day">
          <h2 className="text-sm font-bold text-fg-strong">Plan a day</h2>
          <PlanForm onCancel={() => setPlanning(false)} onPlanned={(d) => router.push(`/admin/van-sales/days/${d.day.id}`)} />
        </section>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 basis-60">
          <label htmlFor={`${uid}-q`} className="sr-only">Search days</label>
          <input id={`${uid}-q`} type="search" className={fieldClass} placeholder="Search by number, route or rep" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />
        </div>
        <div role="group" aria-label="Show" className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" className={`${buttonClass} ${status === f.id ? 'border-indigo-500 bg-indigo-500/10' : ''}`} aria-pressed={status === f.id} onClick={() => setStatus(f.id)}>{f.label}</button>
          ))}
        </div>
      </div>

      {list.phase === 'error' ? <p role="alert" className="text-sm text-red-700">{list.error} <button type="button" className={buttonClass} onClick={list.retry}>Try again</button></p> : null}
      {list.phase === 'loading' ? <p role="status" className="text-sm text-fg-muted">Loading…</p> : null}
      <ul className="space-y-3" aria-label="Van days">
        {list.rows.map((d) => (
          <li key={d.id} className={`${cardClass} space-y-2`}>
            <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1 basis-48 text-base font-semibold text-fg-strong">{d.date} <span className="font-mono text-xs font-normal text-fg-muted">{d.number}</span></p>
              <Chip tone={TONE[d.status]}>{d.statusWords}</Chip>
              <Chip tone="sky">{ROUTE_MODE_WORDS[d.mode]}</Chip>
            </div>
            <p className="text-sm text-fg-muted">
              {d.routeName} · rep {d.repName}{d.vanName === null ? '' : ` · van ${d.vanName}`} · {String(d.visitsDone)} of {String(d.visits)} {d.visits === 1 ? 'visit' : 'visits'} done
            </p>
            {d.status === 'cancelled' && d.statusReason !== null ? <p className="text-sm text-fg-muted">Cancelled because: {d.statusReason}</p> : null}
            <Link href={`/admin/van-sales/days/${d.id}`} className={buttonClass} aria-label={`Open day ${d.number}`}>Open day</Link>
          </li>
        ))}
      </ul>
      {list.phase === 'idle' && list.rows.length === 0 ? (
        <p role="status" className="rounded-xl border border-line bg-surface-raised p-8 text-center text-sm text-fg-muted">
          {query === '' && status === 'open' ? 'No day is open. Plan one from a route, for today or a later date.' : 'No day matches that.'}
        </p>
      ) : null}
      {list.cursor !== null ? <button type="button" className={buttonClass} onClick={list.loadMore} disabled={list.phase === 'more'}>{list.phase === 'more' ? 'Loading…' : 'Show more'}</button> : null}
    </div>
  );
}
