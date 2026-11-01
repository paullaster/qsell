'use client';

import { useId } from 'react';
import { Field, buttonClass, fieldClass } from '@/components/ui/screen-kit';
import { emptySurcharge, emptyTier, nextKey, type SurchargeLine, type TierLine } from '@/lib/charge-policy-form';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** From this order value up, a percentage comes off the delivery charge. 100 is free delivery. */
export function ChargeTiers({ tiers, onChange, disabled }: { tiers: TierLine[]; onChange: (next: TierLine[]) => void; disabled: boolean }) {
  const uid = useId();
  const set = (i: number, patch: Partial<TierLine>) => onChange(tiers.map((t, k) => (k === i ? { ...t, ...patch } : t)));
  return (
    <fieldset className="space-y-3" disabled={disabled}>
      <legend className="text-xs font-semibold text-fg">Discounts for bigger orders</legend>
      <p className="text-xs text-fg-muted">From the order value you set, the delivery charge is reduced by the percentage. Use 100 for free delivery. A bigger order never gets a smaller discount.</p>
      {tiers.length === 0 ? <p className="text-xs text-fg-muted">None. Every order pays the full delivery charge.</p> : null}
      <ul className="space-y-2" aria-label="Order value steps">
        {tiers.map((t, i) => (
          <li key={t.key} className="rounded-lg border border-line bg-surface p-3" aria-label={`Step ${String(i + 1)}`}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id={`${uid}-${String(i)}-min`} label="Orders of at least">
                <input id={`${uid}-${String(i)}-min`} inputMode="decimal" value={t.minOrderValue} onChange={(e) => set(i, { minOrderValue: e.target.value })} className={fieldClass} autoComplete="off" />
              </Field>
              <Field id={`${uid}-${String(i)}-off`} label="Percentage off the delivery charge">
                <input id={`${uid}-${String(i)}-off`} inputMode="decimal" value={t.percentOff} onChange={(e) => set(i, { percentOff: e.target.value })} className={fieldClass} autoComplete="off" />
              </Field>
            </div>
            {disabled ? null : (
              <button type="button" className={`${buttonClass} mt-2`} onClick={() => onChange(tiers.filter((_, k) => k !== i))} aria-label={`Remove step ${String(i + 1)}`}>
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      {disabled ? null : (
        <button type="button" className={buttonClass} onClick={() => onChange([...tiers, emptyTier(nextKey(tiers))])}>
          Add a discount
        </button>
      )}
    </fieldset>
  );
}

/** Extra charges for busy times: days, hours of the day, and a season. Each is a fixed amount or a percentage of the charge before extras. */
export function ChargeSurcharges({ surcharges, onChange, disabled }: { surcharges: SurchargeLine[]; onChange: (next: SurchargeLine[]) => void; disabled: boolean }) {
  const uid = useId();
  const set = (i: number, patch: Partial<SurchargeLine>) => onChange(surcharges.map((s, k) => (k === i ? { ...s, ...patch } : s)));
  return (
    <fieldset className="space-y-3" disabled={disabled}>
      <legend className="text-xs font-semibold text-fg">Extra charges for busy times</legend>
      <p className="text-xs text-fg-muted">For weekends, nights, peak hours or a season such as December. Times are in the business&apos;s time zone. Hours may run past midnight (22:00 to 06:00 belongs to the day it starts), and a season may cross the new year (12-01 to 01-05). A percentage is taken from the charge before any extras, so the order they are listed in makes no difference.</p>
      {surcharges.length === 0 ? <p className="text-xs text-fg-muted">None.</p> : null}
      <ul className="space-y-2" aria-label="Extra charges">
        {surcharges.map((s, i) => {
          const id = `${uid}-${String(i)}`;
          return (
            <li key={s.key} className="space-y-3 rounded-lg border border-line bg-surface p-3" aria-label={`Extra charge ${String(i + 1)}`}>
              <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
                <Field id={`${id}-label`} label="Name">
                  <input id={`${id}-label`} value={s.label} onChange={(e) => set(i, { label: e.target.value })} className={fieldClass} maxLength={60} placeholder="Weekend" autoComplete="off" />
                </Field>
                <div role="radiogroup" aria-label="Fixed amount or percentage" className="flex flex-wrap items-end gap-x-4">
                  {(['fixed', 'percent'] as const).map((kind) => (
                    <label key={kind} className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg">
                      <input type="radio" name={`${id}-kind`} checked={s.kind === kind} onChange={() => set(i, { kind })} />
                      {kind === 'fixed' ? 'Amount' : 'Percent'}
                    </label>
                  ))}
                </div>
                <Field id={`${id}-amount`} label={s.kind === 'fixed' ? 'Extra amount' : 'Percentage'}>
                  <input id={`${id}-amount`} inputMode="decimal" value={s.amount} onChange={(e) => set(i, { amount: e.target.value })} className={fieldClass} autoComplete="off" />
                </Field>
              </div>
              <div role="group" aria-label="Days it applies" className="flex flex-wrap gap-x-3">
                {DAY_NAMES.map((name, day) => (
                  <label key={name} className="flex min-h-10 cursor-pointer items-center gap-1.5 text-sm text-fg">
                    <input type="checkbox" checked={s.days[day] ?? false} onChange={(e) => set(i, { days: s.days.map((on, d) => (d === day ? e.target.checked : on)) })} />
                    {name.slice(0, 3)}
                  </label>
                ))}
                <span className="self-center text-xs text-fg-muted">{s.days.some(Boolean) ? '' : 'No day ticked: every day.'}</span>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg">
                  <input type="checkbox" checked={s.hoursOn} onChange={(e) => set(i, { hoursOn: e.target.checked })} />
                  Only at certain hours
                </label>
                {s.hoursOn ? (
                  <>
                    <Field id={`${id}-from`} label="From">
                      <input id={`${id}-from`} type="time" value={s.from} onChange={(e) => set(i, { from: e.target.value })} className={fieldClass} />
                    </Field>
                    <Field id={`${id}-to`} label="Until">
                      <input id={`${id}-to`} type="time" value={s.to} onChange={(e) => set(i, { to: e.target.value })} className={fieldClass} />
                    </Field>
                  </>
                ) : null}
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg">
                  <input type="checkbox" checked={s.seasonOn} onChange={(e) => set(i, { seasonOn: e.target.checked })} />
                  Only in a season
                </label>
                {s.seasonOn ? (
                  <>
                    <Field id={`${id}-sfrom`} label="First day (month-day)">
                      <input id={`${id}-sfrom`} value={s.dateFrom} onChange={(e) => set(i, { dateFrom: e.target.value })} className={fieldClass} placeholder="12-01" maxLength={5} autoComplete="off" />
                    </Field>
                    <Field id={`${id}-sto`} label="Last day (month-day)">
                      <input id={`${id}-sto`} value={s.dateTo} onChange={(e) => set(i, { dateTo: e.target.value })} className={fieldClass} placeholder="01-05" maxLength={5} autoComplete="off" />
                    </Field>
                  </>
                ) : null}
              </div>
              {disabled ? null : (
                <button type="button" className={buttonClass} onClick={() => onChange(surcharges.filter((_, k) => k !== i))} aria-label={`Remove extra charge ${String(i + 1)}`}>
                  Remove
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {disabled ? null : (
        <button type="button" className={buttonClass} onClick={() => onChange([...surcharges, emptySurcharge(nextKey(surcharges))])}>
          Add an extra charge
        </button>
      )}
    </fieldset>
  );
}
