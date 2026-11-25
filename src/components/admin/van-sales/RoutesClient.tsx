'use client';

import Link from 'next/link';
import { use, useId, useState } from 'react';
import { routesPageAction, type RoutesPage } from '@/server/domains/van-sales/actions';
import type { RouteView } from '@/server/domains/van-sales/routes';
import { useDebouncedValue } from '@/components/ui/useDebouncedValue';
import { usePagedList } from '@/components/ui/usePagedList';
import { Chip, LoadFailed, Message, PageHeader, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { ROUTE_MODE_WORDS, vanSalesOn } from '@/lib/van-sales/settings';
import { RouteForm } from './route/RouteForm';

type Loaded = Awaited<ReturnType<typeof routesPageAction>>;
type Status = 'active' | 'stopped' | 'all';
const FILTERS: { id: Status; label: string }[] = [
  { id: 'active', label: 'In use' },
  { id: 'stopped', label: 'Stopped' },
  { id: 'all', label: 'All' },
];
const plural = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

export function RoutesClient({ firstPromise }: { firstPromise: ReturnType<typeof routesPageAction> }) {
  const res: Loaded = use(firstPromise);
  return res.ok ? <Body first={res.data} /> : <LoadFailed error={res.error} />;
}

function Body({ first }: { first: RoutesPage }) {
  const uid = useId();
  const [status, setStatus] = useState<Status>('active');
  const [text, setText] = useState('');
  const query = useDebouncedValue(text.trim(), 300);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const list = usePagedList<RouteView, { query: string; status: Status }>({
    load: (f, cursor) => routesPageAction({ query: f.query, status: f.status, cursor }),
    filters: { query, status },
    initialPage: { ok: true, data: { rows: first.rows, nextCursor: first.nextCursor } },
  });
  const on = vanSalesOn(first.modes);
  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title="Routes"
        intro="A route is a round of customers: who is visited, on which days and how often, in what order, and the stock the van should start with."
        actions={first.canManage && on && !adding ? <button type="button" className={primaryClass} onClick={() => { setNotice(null); setAdding(true); }}>Add a route</button> : null}
      />
      <Message notice={notice} />
      {on ? null : (
        <p role="status" className={`${cardClass} text-sm text-fg-muted`} data-testid="routes-off">
          Neither van selling nor pre-selling is switched on, so routes cannot be added yet. Switch one on in Settings › Sales › Van sales.
        </p>
      )}
      {adding ? (
        <section className={`${cardClass} space-y-3`} aria-label="Add a route">
          <h2 className="text-sm font-bold text-fg-strong">Add a route</h2>
          <RouteForm modes={first.modes} onCancel={() => setAdding(false)} onSaved={(saved) => { setAdding(false); setNotice({ kind: 'ok', text: `${'name' in saved ? saved.name : saved.route.name} added. Open it to put customers on the route.` }); list.reload(); }} />
        </section>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 basis-60">
          <label htmlFor={`${uid}-q`} className="sr-only">Search routes</label>
          <input id={`${uid}-q`} type="search" className={fieldClass} placeholder="Search by name or code" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />
        </div>
        <div role="group" aria-label="Show" className="flex gap-1">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" className={`${buttonClass} ${status === f.id ? 'border-indigo-500 bg-indigo-500/10' : ''}`} aria-pressed={status === f.id} onClick={() => setStatus(f.id)}>{f.label}</button>
          ))}
        </div>
      </div>

      {list.phase === 'error' ? <p role="alert" className="text-sm text-red-700">{list.error} <button type="button" className={buttonClass} onClick={list.retry}>Try again</button></p> : null}
      {list.phase === 'loading' ? <p role="status" className="text-sm text-fg-muted">Loading…</p> : null}
      <ul className="space-y-3" aria-label="Routes">
        {list.rows.map((r) => (
          <li key={r.id} className={`${cardClass} space-y-2`}>
            <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1 basis-48 text-base font-semibold text-fg-strong">{r.name} <span className="font-mono text-xs font-normal text-fg-muted">{r.code}</span></p>
              <Chip tone={r.status === 'active' ? 'green' : 'gray'}>{r.status === 'active' ? 'In use' : 'Stopped'}</Chip>
              <Chip tone="sky">{ROUTE_MODE_WORDS[r.mode]}</Chip>
            </div>
            <p className="text-sm text-fg-muted">
              {r.branchName} · {plural(r.stops, 'customer', 'customers')} · {r.parLines === 0 ? 'no usual stock set' : plural(r.parLines, 'product', 'products')} on the van
              {r.defaultVanName === null ? '' : ` · van ${r.defaultVanName}`}
              {r.defaultRepName === null ? '' : ` · rep ${r.defaultRepName}`}
            </p>
            {r.status === 'stopped' && r.statusReason !== null ? <p className="text-sm text-fg-muted">Stopped because: {r.statusReason}</p> : null}
            <Link href={`/admin/van-sales/routes/${r.id}`} className={buttonClass} aria-label={`Open route ${r.name}`}>Open route</Link>
          </li>
        ))}
      </ul>
      {list.phase === 'idle' && list.rows.length === 0 ? (
        <p role="status" className="rounded-xl border border-line bg-surface-raised p-8 text-center text-sm text-fg-muted">
          {query === '' && status === 'active' ? 'No route yet. Add the first one, then put customers on it.' : 'No route matches that.'}
        </p>
      ) : null}
      {list.cursor !== null ? <button type="button" className={buttonClass} onClick={list.loadMore} disabled={list.phase === 'more'}>{list.phase === 'more' ? 'Loading…' : 'Show more'}</button> : null}
    </div>
  );
}
