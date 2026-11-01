'use client';

import { useId } from 'react';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { Field, buttonClass, fieldClass } from '@/components/ui/screen-kit';
import { emptyBand, emptyRate, nextKey, type BandLine, type RateLine } from '@/lib/charge-policy-form';
import type { ChargeMethod } from '@/server/domains/delivery/domain/types';

function RowShell({ label, onRemove, disabled, children }: { label: string; onRemove: () => void; disabled: boolean; children: React.ReactNode }) {
  return (
    <li className="rounded-lg border border-line bg-surface p-3" aria-label={label}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[repeat(5,minmax(0,1fr))_auto] lg:items-end">{children}</div>
      {disabled ? null : (
        <button type="button" className={`${buttonClass} mt-2`} onClick={onRemove} aria-label={`Remove ${label.toLowerCase()}`}>
          Remove
        </button>
      )}
    </li>
  );
}

/** The fees of a rate card: one row for each zone (or any other zone) and weight band. A flat card has no zone. */
export function ChargeRateCard({ method, rates, onChange, disabled }: { method: ChargeMethod; rates: RateLine[]; onChange: (next: RateLine[]) => void; disabled: boolean }) {
  const uid = useId();
  const set = (i: number, patch: Partial<RateLine>) => onChange(rates.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const byZone = method === 'zone_rate';
  return (
    <fieldset className="space-y-3" disabled={disabled}>
      <legend className="text-xs font-semibold text-fg">{byZone ? 'Fees by zone and weight' : 'Fees by weight'}</legend>
      <p className="text-xs text-fg-muted">
        {byZone ? 'A row with no zone is the fee for any zone that has no row of its own. ' : ''}
        Weights run from 0 kg with no gaps: each band starts where the one before ends, and the last band has no upper limit so every weight has a fee. The extra-kilogram fee belongs to that last band.
      </p>
      <ul className="space-y-2" aria-label="Fees">
        {rates.map((r, i) => (
          <RowShell key={r.key} label={`Fee ${String(i + 1)}`} onRemove={() => onChange(rates.filter((_, k) => k !== i))} disabled={disabled}>
            {byZone ? (
              <div className="sm:col-span-2 lg:col-span-1">
                <ChoicePicker label="Zone" source="delivery-zones" choice={r.zone} onChoice={(zone) => set(i, { zone })} placeholder="Any other zone" clearable />
              </div>
            ) : null}
            <Field id={`${uid}-${String(i)}-from`} label="From kg">
              <input id={`${uid}-${String(i)}-from`} inputMode="decimal" value={r.fromKg} onChange={(e) => set(i, { fromKg: e.target.value })} className={fieldClass} autoComplete="off" />
            </Field>
            <Field id={`${uid}-${String(i)}-to`} label="Up to kg" hint="Empty: no limit">
              <input id={`${uid}-${String(i)}-to`} inputMode="decimal" value={r.toKg} onChange={(e) => set(i, { toKg: e.target.value })} className={fieldClass} autoComplete="off" />
            </Field>
            <Field id={`${uid}-${String(i)}-fee`} label="Fee">
              <input id={`${uid}-${String(i)}-fee`} inputMode="decimal" value={r.fee} onChange={(e) => set(i, { fee: e.target.value })} className={fieldClass} autoComplete="off" />
            </Field>
            <Field id={`${uid}-${String(i)}-extra`} label="Each extra kg" hint="Top band only">
              <input id={`${uid}-${String(i)}-extra`} inputMode="decimal" value={r.perExtraKg} onChange={(e) => set(i, { perExtraKg: e.target.value })} className={fieldClass} autoComplete="off" />
            </Field>
          </RowShell>
        ))}
      </ul>
      {disabled ? null : (
        <button type="button" className={buttonClass} onClick={() => onChange([...rates, emptyRate(nextKey(rates))])}>
          Add a fee
        </button>
      )}
    </fieldset>
  );
}

/** The distance bands of a charge by distance: a base fee and a rate for each kilometre past the start of the band. */
export function ChargeBands({ bands, onChange, disabled }: { bands: BandLine[]; onChange: (next: BandLine[]) => void; disabled: boolean }) {
  const uid = useId();
  const set = (i: number, patch: Partial<BandLine>) => onChange(bands.map((b, k) => (k === i ? { ...b, ...patch } : b)));
  return (
    <fieldset className="space-y-3" disabled={disabled}>
      <legend className="text-xs font-semibold text-fg">Distance bands</legend>
      <p className="text-xs text-fg-muted">The fee is the base fee of the band the distance falls in, plus the rate for each kilometre past the start of that band. Bands start at 0 km with no gaps, and the last band has no upper limit (use the furthest distance to stop deliveries beyond a point).</p>
      <ul className="space-y-2" aria-label="Distance bands">
        {bands.map((b, i) => (
          <li key={b.key} className="rounded-lg border border-line bg-surface p-3" aria-label={`Band ${String(i + 1)}`}>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field id={`${uid}-${String(i)}-from`} label="From km">
                <input id={`${uid}-${String(i)}-from`} inputMode="decimal" value={b.fromKm} onChange={(e) => set(i, { fromKm: e.target.value })} className={fieldClass} autoComplete="off" />
              </Field>
              <Field id={`${uid}-${String(i)}-to`} label="Up to km" hint="Empty: no limit">
                <input id={`${uid}-${String(i)}-to`} inputMode="decimal" value={b.toKm} onChange={(e) => set(i, { toKm: e.target.value })} className={fieldClass} autoComplete="off" />
              </Field>
              <Field id={`${uid}-${String(i)}-base`} label="Base fee">
                <input id={`${uid}-${String(i)}-base`} inputMode="decimal" value={b.baseFee} onChange={(e) => set(i, { baseFee: e.target.value })} className={fieldClass} autoComplete="off" />
              </Field>
              <Field id={`${uid}-${String(i)}-perkm`} label="For each km past the start">
                <input id={`${uid}-${String(i)}-perkm`} inputMode="decimal" value={b.perKm} onChange={(e) => set(i, { perKm: e.target.value })} className={fieldClass} autoComplete="off" />
              </Field>
            </div>
            {disabled ? null : (
              <button type="button" className={`${buttonClass} mt-2`} onClick={() => onChange(bands.filter((_, k) => k !== i))} aria-label={`Remove band ${String(i + 1)}`}>
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      {disabled ? null : (
        <button type="button" className={buttonClass} onClick={() => onChange([...bands, emptyBand(bands.at(-1)?.toKm ?? '', nextKey(bands))])}>
          Add a band
        </button>
      )}
    </fieldset>
  );
}
