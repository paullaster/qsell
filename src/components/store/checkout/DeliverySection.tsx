'use client';

import dynamic from 'next/dynamic';
import { useId } from 'react';
import { LocateFixed, Search } from 'lucide-react';
import { useStore } from '@/components/store/StoreContext';
import type { ShopDelivery } from '@/components/store/checkout/useShopDelivery';
import { DeliveryTimes } from '@/components/store/checkout/DeliveryTimes';
import { PickupSection } from '@/components/store/checkout/PickupSection';

// The map is drawn only in the browser, and only for a shop whose map service has one.
const MapPicker = dynamic(() => import('@/components/store/checkout/MapPicker').then((m) => m.MapPicker), {
  ssr: false,
  loading: () => <div role="status" className="flex h-64 items-center justify-center rounded-xl border border-line bg-surface-raised text-sm text-fg-muted">Loading the map…</div>,
});

const inputClass =
  'min-h-11 w-full rounded-lg border border-line bg-surface px-3.5 py-2 text-sm text-fg-strong placeholder-fg-subtle focus:border-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40';
const buttonClass = 'inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-lg border border-line-strong bg-surface-raised px-4 text-sm font-semibold text-fg-strong hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50';

const METHOD_LABELS = { own_fleet: 'Our riders', courier: 'A courier', pickup: 'Collect from a branch' } as const;

export interface Recipient {
  on: boolean;
  name: string;
  phone: string;
}

/**
 * Where the order goes and what getting it there costs: a pin on the map, a place searched for, the device's location or a
 * written area, who will receive it, and the charge with how it was worked out. The charge comes from the server for the pin or
 * area and the basket, so it is the one the order will carry.
 */
export function DeliverySection({ delivery, recipient, onRecipient, notes, onNotes, onUseNamed }: { delivery: ShopDelivery; recipient: Recipient; onRecipient: (next: Recipient) => void; notes: string; onNotes: (text: string) => void; onUseNamed: () => void }) {
  const uid = useId();
  const { money } = useStore();
  const { options, quote } = delivery;
  if (options === null) return delivery.loaded ? null : <p role="status" className="text-sm text-fg-muted">Checking how we can deliver to you…</p>;
  if (options.methods.length === 0) return null;
  const map = options.clientMap;
  const leaflet = map !== null && map.driver === 'leaflet' && typeof map.options.tileUrl === 'string' ? { tileUrl: map.options.tileUrl, attribution: map.options.attribution ?? '© OpenStreetMap contributors' } : null;

  return (
    <div className="space-y-4 rounded-xl border border-line bg-surface p-4" role="group" aria-label="Where to deliver and what it costs">
      {delivery.method === 'pickup' ? null : (
        <div>
          <h3 className="text-sm font-semibold text-fg-strong">Show us where to deliver</h3>
          <p className="mt-1 text-xs text-fg-muted">Drop a pin on the map, or write your area in the address above. Either one tells us which branch sends your order and what delivery costs.</p>
        </div>
      )}

      {options.methods.length > 1 ? (
        <fieldset className="flex flex-wrap gap-4">
          <legend className="sr-only">How should we get your order to you?</legend>
          {options.methods.map((m) => (
            <label key={m} className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-fg">
              <input type="radio" name={`${uid}-method`} className="h-4 w-4 accent-indigo-600" checked={delivery.method === m} onChange={() => delivery.setMethod(m)} />
              {METHOD_LABELS[m]}
            </label>
          ))}
        </fieldset>
      ) : null}

      {delivery.method === 'pickup' ? <PickupSection delivery={delivery} /> : null}

      {delivery.method === 'pickup' ? null : (
      <>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass} onClick={delivery.locate.run} disabled={delivery.locate.busy}>
          <LocateFixed className="h-4 w-4" aria-hidden="true" />
          {delivery.locate.busy ? 'Finding you…' : 'Use my location'}
        </button>
        {delivery.pin === null ? null : (
          <button type="button" className={buttonClass} onClick={() => delivery.setPin(null)}>
            Remove the pin
          </button>
        )}
      </div>
      {delivery.locate.error === null ? null : (
        <p role="alert" className="text-sm text-red-700">
          {delivery.locate.error}
        </p>
      )}

      {options.canSearch ? (
        <div className="space-y-2">
          <label htmlFor={`${uid}-search`} className="block text-sm font-medium text-fg">
            Find a place by name
          </label>
          <div className="flex gap-2">
            <input
              id={`${uid}-search`}
              value={delivery.search.text}
              onChange={(e) => delivery.search.setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  delivery.search.run();
                }
              }}
              className={inputClass}
              placeholder="An estate, a building or a landmark"
              autoComplete="off"
            />
            <button type="button" className={buttonClass} onClick={delivery.search.run} disabled={delivery.search.busy || delivery.search.text.trim().length < 3}>
              <Search className="h-4 w-4" aria-hidden="true" />
              {delivery.search.busy ? 'Searching…' : 'Search'}
            </button>
          </div>
          {delivery.search.error === null ? null : (
            <p role="alert" className="text-sm text-red-700">
              {delivery.search.error}
            </p>
          )}
          {delivery.search.results.length === 0 ? null : (
            <ul aria-label="Places found" className="divide-y divide-line overflow-hidden rounded-lg border border-line">
              {delivery.search.results.map((place) => (
                <li key={place.id}>
                  <button type="button" className="min-h-11 w-full cursor-pointer px-3 py-2 text-left text-sm hover:bg-hover" onClick={() => delivery.setPin(place.point)}>
                    <span className="block font-medium text-fg-strong">{place.label}</span>
                    {place.secondary === null ? null : <span className="block text-xs text-fg-muted">{place.secondary}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {leaflet === null ? null : (
        <div className="space-y-1">
          <MapPicker tileUrl={leaflet.tileUrl} attribution={leaflet.attribution} centre={options.centre} pin={delivery.pin} onPin={delivery.setPin} label="Map. Tap or click to drop your delivery pin, drag the pin to adjust it." />
          <p className="text-xs text-fg-muted">{delivery.pin === null ? 'Tap the map to drop your pin.' : 'Pin placed. Drag it to adjust.'}</p>
        </div>
      )}

      {delivery.named === null ? null : (
        <div className="rounded-lg border border-line bg-surface-raised p-3 text-sm" role="status">
          <p className="text-fg-muted">The pin is near</p>
          <p className="font-medium text-fg-strong">{delivery.named.label}</p>
          <button type="button" className={`${buttonClass} mt-2`} onClick={onUseNamed}>
            Fill in my address from this
          </button>
        </div>
      )}
      {delivery.nameNotice === null ? null : <p className="text-xs text-fg-muted">{delivery.nameNotice}</p>}

      <div className="space-y-3">
        <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-fg">
          <input type="checkbox" className="h-4 w-4 accent-indigo-600" checked={recipient.on} onChange={(e) => onRecipient({ ...recipient, on: e.target.checked })} />
          Someone else will receive the order
        </label>
        {recipient.on ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={`${uid}-rname`} className="mb-1 block text-sm font-medium text-fg">
                Their name
              </label>
              <input id={`${uid}-rname`} value={recipient.name} onChange={(e) => onRecipient({ ...recipient, name: e.target.value })} className={inputClass} autoComplete="off" />
            </div>
            <div>
              <label htmlFor={`${uid}-rphone`} className="mb-1 block text-sm font-medium text-fg">
                Their mobile number
              </label>
              <input id={`${uid}-rphone`} type="tel" inputMode="tel" value={recipient.phone} onChange={(e) => onRecipient({ ...recipient, phone: e.target.value })} className={`${inputClass} font-mono`} autoComplete="off" placeholder="07XX XXX XXX" />
            </div>
          </div>
        ) : null}
        <div>
          <label htmlFor={`${uid}-notes`} className="mb-1 block text-sm font-medium text-fg">
            Note for the rider (optional)
          </label>
          <input id={`${uid}-notes`} value={notes} onChange={(e) => onNotes(e.target.value)} maxLength={300} className={inputClass} placeholder="Gate colour, floor, who to ask for" autoComplete="off" />
        </div>
      </div>

      <div aria-live="polite" className="rounded-lg border border-line bg-surface-raised p-3 text-sm">
        {quote.phase === 'idle' ? <p className="text-fg-muted">Drop a pin or write your area, and we will tell you what delivery costs.</p> : null}
        {quote.phase === 'loading' ? <p role="status" className="text-fg-muted">Working out your delivery…</p> : null}
        {quote.phase === 'error' ? (
          <p role="alert" className="text-red-700">
            {quote.error}
          </p>
        ) : null}
        {quote.phase === 'ok' ? (
          <div className="space-y-2">
            <p className="font-semibold text-fg-strong" role="status">
              Delivery from {quote.quote.branchName}: {quote.quote.gross === 0 ? 'free' : money(quote.quote.gross)}
            </p>
            <p className="text-xs text-fg-muted">{quote.quote.why}</p>
            {quote.quote.tax > 0 ? (
              <p className="text-xs text-fg-muted">
                Includes {money(quote.quote.tax)} tax ({quote.quote.taxRate}%).
              </p>
            ) : null}
            {quote.quote.caution === null ? null : <p className="text-xs text-amber-700">{quote.quote.caution}</p>}
            <details className="text-xs text-fg-muted">
              <summary className="cursor-pointer">How this was worked out</summary>
              <ul className="mt-1 space-y-0.5">
                {quote.quote.steps.map((s) => (
                  <li key={s.label}>{s.label}</li>
                ))}
              </ul>
            </details>
          </div>
        ) : null}
      </div>
      {quote.phase === 'ok' ? <DeliveryTimes slots={delivery.slots} /> : null}
      </>
      )}
    </div>
  );
}
