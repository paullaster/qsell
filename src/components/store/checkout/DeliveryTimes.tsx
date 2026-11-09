'use client';

import { useId } from 'react';
import type { ShopDelivery } from '@/components/store/checkout/useShopDelivery';

const buttonClass = 'inline-flex min-h-11 cursor-pointer items-center justify-center rounded-lg border border-line-strong bg-surface-raised px-4 text-sm font-semibold text-fg-strong hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60';

/**
 * The delivery times the shop offers for this basket and place, with the earliest one up front. Choosing one is optional: an order with no
 * time chosen is delivered when dispatch plans it. A time that cannot be chosen says why, so a full or closed one is not a mystery.
 */
export function DeliveryTimes({ slots }: { slots: ShopDelivery['slots'] }) {
  const uid = useId();
  const { phase, chosen, choose } = slots;
  if (phase.phase === 'idle') return null;
  if (phase.phase === 'loading') return <p role="status" className="text-sm text-fg-muted">Looking for delivery times…</p>;
  if (phase.phase === 'error') return <p role="status" className="text-sm text-fg-muted">We could not load delivery times just now. You can still place your order and we will plan its delivery.</p>;
  const { days, earliest } = phase.offer;
  if (days.length === 0) return null;
  return (
    <fieldset className="space-y-3 rounded-lg border border-line bg-surface-raised p-3">
      <legend className="px-1 text-sm font-semibold text-fg-strong">When would you like it? (optional)</legend>
      {earliest === null ? (
        <p className="text-sm text-fg-muted">Every delivery time in the next days is taken. You can still place your order and we will plan its delivery.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-fg">
            Earliest: <strong>{earliest.words}</strong>
          </p>
          <button type="button" className={buttonClass} onClick={() => choose({ slotId: earliest.slotId, day: earliest.day })} disabled={chosen?.slotId === earliest.slotId && chosen.day === earliest.day}>
            {chosen?.slotId === earliest.slotId && chosen.day === earliest.day ? 'Chosen' : 'Choose this time'}
          </button>
        </div>
      )}
      <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-fg">
        <input type="radio" name={`${uid}-time`} className="h-4 w-4 accent-indigo-600" checked={chosen === null} onChange={() => choose(null)} />
        No preference
      </label>
      {days.map((d) => (
        <div key={d.day} role="group" aria-label={d.label} className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">{d.label}</p>
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            {d.slots.map((s) => (
              <label key={s.slotId} className={`flex min-h-11 items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm ${s.available ? 'cursor-pointer text-fg' : 'cursor-not-allowed text-fg-subtle'}`}>
                <input type="radio" name={`${uid}-time`} className="h-4 w-4 accent-indigo-600" disabled={!s.available} checked={chosen?.slotId === s.slotId && chosen.day === d.day} onChange={() => choose({ slotId: s.slotId, day: d.day })} />
                <span>
                  {s.label}
                  {s.note === null ? null : <span className="block text-xs text-fg-muted">{s.note}</span>}
                </span>
              </label>
            ))}
          </div>
        </div>
      ))}
    </fieldset>
  );
}
