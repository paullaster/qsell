'use client';

import { WEEKDAY_NAMES } from '@/lib/van-sales/visits';

/** The days of the week a customer is visited: seven tick boxes, Monday first, each named in full for a screen reader. */
export function WeekdayPicker({ value, onChange }: { value: number; onChange: (next: number) => void }) {
  return (
    <fieldset className="space-y-1">
      <legend className="mb-1 text-sm font-semibold text-fg-strong">Days of the week</legend>
      <div className="flex flex-wrap gap-2">
        {WEEKDAY_NAMES.map((day, i) => {
          const on = (value & (1 << i)) !== 0;
          return (
            <label key={day} className={`flex min-h-10 min-w-12 cursor-pointer items-center justify-center gap-1.5 rounded-lg border px-3 text-sm ${on ? 'border-indigo-500 bg-indigo-500/10 font-semibold' : 'border-line'}`}>
              <input type="checkbox" className="size-4" aria-label={day} checked={on} onChange={() => onChange(on ? value & ~(1 << i) : value | (1 << i))} />
              <span aria-hidden>{day.slice(0, 3)}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
