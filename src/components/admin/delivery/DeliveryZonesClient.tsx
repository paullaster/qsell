'use client';

import { use, useId, useState } from 'react';
import { deliveryZonesPageAction, setDeliveryZoneActiveAction, type ZoneView } from '@/server/domains/delivery/actions';
import { DeliveryZoneForm } from './DeliveryZoneForm';
import { DeliveryZoneAreas } from './DeliveryZoneAreas';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { usePagedList } from '@/components/ui/usePagedList';
import { attempt, buttonClass, cardClass, Chip, fieldClass, LoadFailed, Message, PageHeader, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { has } from '@/lib/values';

type FirstPage = Awaited<ReturnType<typeof deliveryZonesPageAction>>;

export function DeliveryZonesClient({ firstPage, canManage }: { firstPage: ReturnType<typeof deliveryZonesPageAction>; canManage: Promise<boolean> }) {
  const first = use(firstPage);
  const may = use(canManage);
  return first.ok ? <ZonesView first={first} may={may} /> : <LoadFailed error={first.error} />;
}

function ZonesView({ first, may }: { first: FirstPage; may: boolean }) {
  const uid = useId();
  const [query, setQuery] = useState('');
  const [showStopped, setShowStopped] = useState(false);
  const [editing, setEditing] = useState<ZoneView | 'new' | null>(null);
  const [openPlaces, setOpenPlaces] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const list = usePagedList<ZoneView, { query: string; showStopped: boolean }>({
    load: (filters, cursor) => deliveryZonesPageAction({ query: filters.query, cursor, status: filters.showStopped ? 'all' : 'active' }),
    filters: { query: query.trim(), showStopped },
    initialPage: first,
  });

  const toggle = async (z: ZoneView, active: boolean) => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(setDeliveryZoneActiveAction(z.id, active));
    setBusy(false);
    setNotice(res.ok ? { kind: 'ok', text: `${z.code} ${active ? 'is in use again' : 'stopped'}.` } : { kind: 'error', text: res.error });
    if (res.ok) list.reload();
  };

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title="Delivery zones"
        intro="The areas you deliver to. A customer who writes their address is matched to a zone through the places you list in it; one who drops a pin on the map is matched through the zone's coverage circle. A place belongs to one zone only. Zones are stopped, not deleted, because delivery charges and orders refer to them."
        actions={
          may && editing === null ? (
            <button
              type="button"
              className={primaryClass}
              onClick={() => {
                setNotice(null);
                setEditing('new');
              }}
            >
              New zone
            </button>
          ) : null
        }
      />
      <Message notice={notice} />

      {may && editing !== null ? (
        <section className={`${cardClass} space-y-3`} aria-label={editing === 'new' ? 'New delivery zone' : `Edit ${editing.code}`}>
          <h3 className="text-sm font-bold text-fg-strong">{editing === 'new' ? 'New delivery zone' : `Edit ${editing.code}`}</h3>
          <DeliveryZoneForm
            key={editing === 'new' ? 'new' : `${editing.id}-${String(editing.version)}`}
            zone={editing === 'new' ? null : editing}
            autoFocus
            onCancel={() => setEditing(null)}
            onSaved={(saved) => {
              const created = editing === 'new';
              setEditing(null);
              setNotice({ kind: 'ok', text: `${saved.code} ${created ? 'added' : 'saved'}.` });
              list.reload();
            }}
          />
        </section>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,20rem)_auto] sm:items-end">
        <div>
          <label htmlFor={`${uid}-search`} className="sr-only">
            Search zones
          </label>
          <input id={`${uid}-search`} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by code or name" className={fieldClass} autoComplete="off" />
        </div>
        <label className="flex min-h-10 items-center gap-2 text-sm text-fg">
          <input type="checkbox" checked={showStopped} onChange={(e) => setShowStopped(e.target.checked)} />
          Show stopped zones
        </label>
      </div>

      {list.phase === 'error' ? (
        <p role="alert" className="text-sm text-red-700">
          {list.error}{' '}
          <button type="button" className={buttonClass} onClick={list.retry}>
            Try again
          </button>
        </p>
      ) : null}
      {list.phase === 'loading' ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading…
        </p>
      ) : null}

      <ul className="space-y-2" aria-label="Delivery zones">
        {list.rows.map((z) => (
          <li key={z.id} className="rounded-xl border border-line bg-surface-raised p-3 sm:p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-bold break-words text-fg-strong">
                  <span className="font-mono">{z.code}</span> · {z.name}
                </p>
                {has(z.description) ? <p className="mt-1 text-xs break-words text-fg-muted">{z.description}</p> : null}
                <p className="mt-1.5 flex flex-wrap gap-1.5">
                  {z.isActive ? null : <Chip tone="amber">Stopped</Chip>}
                  <Chip tone="gray">{z.areaCount === 0 ? 'No places yet' : `${String(z.areaCount)} place${z.areaCount === 1 ? '' : 's'}`}</Chip>
                  {z.centre !== null && z.radiusKm !== null ? <Chip tone="sky">Pin circle: {String(z.radiusKm)} km around {z.centre.latitude.toFixed(4)}, {z.centre.longitude.toFixed(4)}</Chip> : <Chip tone="gray">No pin circle</Chip>}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className={buttonClass} aria-expanded={openPlaces === z.id} onClick={() => setOpenPlaces((o) => (o === z.id ? null : z.id))} aria-label={`${openPlaces === z.id ? 'Hide' : 'Show'} the places in ${z.code}`}>
                  {openPlaces === z.id ? 'Hide places' : 'Places'}
                </button>
                {may ? (
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={busy}
                    onClick={() => {
                      setNotice(null);
                      setEditing(z);
                    }}
                    aria-label={`Edit ${z.code}`}
                  >
                    Edit
                  </button>
                ) : null}
                {may && z.isActive ? <InlineConfirm label={`Stop ${z.code}`} action="Stop" confirm="Yes, stop it" busy={busy} onConfirm={() => void toggle(z, false)} /> : null}
                {may && !z.isActive ? (
                  <button type="button" className={buttonClass} disabled={busy} onClick={() => void toggle(z, true)} aria-label={`Restart ${z.code}`}>
                    Restart
                  </button>
                ) : null}
              </div>
            </div>
            {openPlaces === z.id ? <DeliveryZoneAreas zoneId={z.id} zoneCode={z.code} isActive={z.isActive} may={may} onChanged={list.reload} /> : null}
          </li>
        ))}
      </ul>

      {list.phase === 'idle' && list.rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line p-6 text-center text-sm text-fg-muted">{query.trim() === '' ? 'No delivery zones yet. Add the first one to start pricing deliveries by area.' : 'No zone matches that search.'}</p>
      ) : null}
      {list.cursor !== null ? (
        <button type="button" className={buttonClass} onClick={list.loadMore} disabled={list.phase === 'more'}>
          {list.phase === 'more' ? 'Loading…' : 'Show more'}
        </button>
      ) : null}
    </div>
  );
}
