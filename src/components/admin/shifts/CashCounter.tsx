'use client';

import { useId, useState } from 'react';
import { KES_DENOMINATIONS, totalOf } from '@/server/domains/selling/shifts/shift-rules';
import { fieldClass } from '@/components/ui/screen-kit';

/** What the screen sends for a count: the notes and coins, or a quick total. */
export type CountValue = { counted: { value: number; count: number }[] } | { total: number };

const money = (amount: number): string => `KES ${amount.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Counting cash: a box for each note and coin with the total as it grows, or (for a quick count) just a total. The server checks the
 * count again; this only makes it easy and shows the sum.
 */
export function CashCounter({ label, onChange }: { label: string; onChange: (value: CountValue | null) => void }) {
  const id = useId();
  const [counts, setCounts] = useState<Record<number, string>>({});
  const [quick, setQuick] = useState(false);
  const [total, setTotal] = useState('');
  const entries = KES_DENOMINATIONS.map((value) => ({ value, count: Number(counts[value] ?? '') })).filter((e) => Number.isInteger(e.count) && e.count > 0);
  const sum = totalOf(entries);
  let summary = `Counted: ${money(sum)}`;
  if (quick) summary = total.trim() === '' ? 'Enter the total' : money(Number.isFinite(Number(total)) ? Number(total) : 0);
  const emit = (nextCounts: Record<number, string>, nextQuick: boolean, nextTotal: string) => {
    if (nextQuick) {
      const t = Number(nextTotal);
      onChange(nextTotal.trim() !== '' && Number.isFinite(t) && t >= 0 ? { total: t } : null);
      return;
    }
    const list = KES_DENOMINATIONS.map((value) => ({ value, count: Number(nextCounts[value] ?? '') })).filter((e) => Number.isInteger(e.count) && e.count > 0);
    onChange(list.length > 0 ? { counted: list } : { counted: [] });
  };
  return (
    <fieldset className="space-y-2 rounded-lg border border-line p-3">
      <legend className="px-1 text-sm font-medium text-fg">{label}</legend>
      <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm">
        <input type="checkbox" className="size-4" checked={quick} onChange={(e) => { setQuick(e.target.checked); emit(counts, e.target.checked, total); }} />
        I only have a total
      </label>
      {quick ? (
        <div>
          <label htmlFor={`${id}-total`} className="mb-1 block text-sm text-fg-muted">Total counted (KES)</label>
          <input id={`${id}-total`} type="number" min={0} step="0.01" className={`${fieldClass} w-48`} value={total} onChange={(e) => { setTotal(e.target.value); emit(counts, true, e.target.value); }} />
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {KES_DENOMINATIONS.map((value) => (
            <div key={value}>
              <label htmlFor={`${id}-${String(value)}`} className="mb-1 block text-xs text-fg-muted">{value.toLocaleString()}</label>
              <input id={`${id}-${String(value)}`} aria-label={`How many ${String(value)} shilling ${value >= 50 ? 'notes' : 'notes or coins'}`} type="number" inputMode="numeric" min={0} step={1} className={`${fieldClass} w-full`} value={counts[value] ?? ''} onChange={(e) => { const next = { ...counts, [value]: e.target.value }; setCounts(next); emit(next, false, total); }} />
            </div>
          ))}
        </div>
      )}
      <p className="text-sm font-semibold text-fg-strong" data-testid="counted-total" aria-live="polite">{summary}</p>
    </fieldset>
  );
}
