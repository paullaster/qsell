'use client';

import { useId } from 'react';
import { MapPin, Phone } from 'lucide-react';
import { useStore } from '@/components/store/StoreContext';
import type { ShopDelivery } from '@/components/store/checkout/useShopDelivery';

/**
 * Collecting an order from a branch: the branches that offer it and have everything in the basket, with their address, phone and how
 * soon the order is ready, and the one the shopper chooses. Collecting costs nothing; the shopper is given a code after paying, to
 * show at the counter. Which branches can be chosen is the server's answer, and the choice is checked again when the order is placed.
 */
export function PickupSection({ delivery }: { delivery: ShopDelivery }) {
  const uid = useId();
  const { money } = useStore();
  const { points, error, chosen, choose } = delivery.pickup;
  const { quote } = delivery;

  return (
    <div className="space-y-4" role="group" aria-label="Where to collect your order">
      <div>
        <h3 className="text-sm font-semibold text-fg-strong">Choose where to collect</h3>
        <p className="mt-1 text-xs text-fg-muted">Collecting is free. After you pay we give you a code to show at the counter, so keep your phone with you.</p>
      </div>

      {points === null && error === null ? (
        <p role="status" className="text-sm text-fg-muted">
          Finding the branches you can collect from…
        </p>
      ) : null}
      {error === null ? null : (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {points !== null && points.length === 0 ? (
        <p role="status" className="rounded-lg border border-line bg-surface-raised p-3 text-sm text-fg-muted">
          No branch can have everything in your basket ready for collection right now. You can have it delivered instead, or change your basket.
        </p>
      ) : null}

      {points === null || points.length === 0 ? null : (
        <fieldset className="space-y-2">
          <legend className="sr-only">Branch to collect from</legend>
          {points.map((point) => {
            const selected = chosen === point.branchId;
            return (
              <label
                key={point.branchId}
                className={`flex min-h-11 gap-3 rounded-xl border p-3 text-sm ${point.holdsAll ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'} ${selected ? 'border-indigo-500 bg-indigo-600/10' : 'border-line bg-surface hover:border-line-strong'}`}
              >
                <input type="radio" name={`${uid}-branch`} className="mt-1 h-4 w-4 shrink-0 accent-indigo-600" checked={selected} disabled={!point.holdsAll} onChange={() => choose(point.branchId)} />
                <span className="min-w-0 space-y-0.5">
                  <span className="block font-semibold text-fg-strong">{point.name}</span>
                  {point.address === '' ? null : (
                    <span className="flex items-start gap-1.5 text-fg-muted">
                      <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span className="break-words">{point.address}</span>
                    </span>
                  )}
                  {point.landmark === null ? null : <span className="block text-xs text-fg-muted">Near {point.landmark}</span>}
                  {point.phone === null ? null : (
                    <span className="flex items-center gap-1.5 text-xs text-fg-muted">
                      <Phone className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      {point.phone}
                    </span>
                  )}
                  <span className="block text-xs text-fg-muted">{point.holdsAll ? `Ready: ${point.ready.toLowerCase()}` : 'Does not have everything in your basket right now'}</span>
                  {point.note === null ? null : <span className="block text-xs text-fg-muted">{point.note}</span>}
                </span>
              </label>
            );
          })}
        </fieldset>
      )}

      <div aria-live="polite" className="rounded-lg border border-line bg-surface-raised p-3 text-sm">
        {quote.phase === 'idle' ? <p className="text-fg-muted">Choose a branch to collect from.</p> : null}
        {quote.phase === 'loading' ? (
          <p role="status" className="text-fg-muted">
            Checking the branch…
          </p>
        ) : null}
        {quote.phase === 'error' ? (
          <p role="alert" className="text-red-700">
            {quote.error}
          </p>
        ) : null}
        {quote.phase === 'ok' ? (
          <p className="font-semibold text-fg-strong" role="status">
            Collect from {quote.quote.branchName}: {quote.quote.gross === 0 ? 'free' : money(quote.quote.gross)}
          </p>
        ) : null}
      </div>
    </div>
  );
}
