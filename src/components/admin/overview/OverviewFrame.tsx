'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';

export interface FilterState {
  preset: string;
  compare: string;
  /** Selected branch id, or '' for all. */
  branchId: string;
  fromDate: string;
  toDate: string;
  rangeLabel: string;
  compareRangeLabel: string;
  scopeLabel: string;
  updatedLabel: string;
  presets: { value: string; label: string }[];
  compareModes: { value: string; label: string }[];
  /** Only set for viewers who may choose a branch. */
  branches: { id: string; name: string }[] | null;
}

const fieldClass =
  'min-h-11 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong focus:border-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40';

/**
 * The filter bar and the frame around the report. Every control applies immediately: it writes
 * the URL (so a view can be bookmarked and shared) and the server re-renders the numbers. While
 * that happens the old figures are dimmed and an "Updating" status is announced, so the screen
 * never silently shows stale data.
 */
export function OverviewFrame({
  filters,
  children,
}: {
  filters: FilterState;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  // Draft dates live locally until they form a valid range; the server value wins otherwise.
  const [from, setFrom] = useState(filters.fromDate);
  const [to, setTo] = useState(filters.toDate);
  const urlKey = params.toString();
  useEffect(() => {
    // Whenever the address changes (a click, Back, Forward), the inputs show what the report shows.
    setFrom(filters.fromDate);
    setTo(filters.toDate);
  }, [filters.fromDate, filters.toDate, urlKey]);

  const rangeInvalid = from !== '' && to !== '' && from > to;
  const lastPush = useRef('');

  const apply = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    const qs = next.toString();
    if (qs === lastPush.current && !pending) return;
    lastPush.current = qs;
    startTransition(() => {
      router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    });
  };

  const applyDates = (nextFrom: string, nextTo: string) => {
    setFrom(nextFrom);
    setTo(nextTo);
    // Choosing dates means a custom range, whatever preset was selected before.
    if (nextFrom && nextTo && nextFrom <= nextTo) {
      apply({ period: 'custom', from: nextFrom, to: nextTo });
    }
  };

  return (
    <div className="space-y-5">
      <section
        aria-label="Report filters"
        className="space-y-3 rounded-xl border border-line bg-surface-raised p-3 sm:p-4"
      >
        <div role="group" aria-label="Period" className="flex flex-wrap gap-1.5">
          {filters.preset === 'custom' ? (
            <button
              type="button"
              aria-pressed="true"
              disabled
              className="min-h-10 rounded-full border border-indigo-600 bg-indigo-600 px-3.5 py-1.5 text-sm font-medium text-white"
            >
              Custom range
            </button>
          ) : null}
          {filters.presets.map((p) => {
            const active = filters.preset === p.value;
            return (
              <button
                key={p.value}
                type="button"
                aria-pressed={active}
                onClick={() => apply({ period: p.value, from: null, to: null })}
                className={`min-h-10 rounded-full border px-3.5 py-1.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-indigo-500 ${
                  active
                    ? 'border-indigo-600 bg-indigo-600 text-white'
                    : 'border-line bg-surface text-fg hover:bg-hover'
                }`}
              >
                {p.label}
              </button>
            );
          })}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block text-xs font-semibold text-fg-subtle">
            From
            <input
              type="date"
              value={from}
              max={to || undefined}
              onChange={(e) => applyDates(e.target.value, to)}
              className={`${fieldClass} mt-1`}
              aria-invalid={rangeInvalid}
            />
          </label>
          <label className="block text-xs font-semibold text-fg-subtle">
            To
            <input
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => applyDates(from, e.target.value)}
              className={`${fieldClass} mt-1`}
              aria-invalid={rangeInvalid}
            />
          </label>
          <label className="block text-xs font-semibold text-fg-subtle">
            Compare with
            <select
              value={filters.compare}
              onChange={(e) => apply({ compare: e.target.value })}
              className={`${fieldClass} mt-1`}
            >
              {filters.compareModes.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          {filters.branches && filters.branches.length > 1 ? (
            <label className="block text-xs font-semibold text-fg-subtle">
              Branch
              <select
                value={filters.branchId}
                onChange={(e) => apply({ branch: e.target.value })}
                className={`${fieldClass} mt-1`}
              >
                <option value="">All branches</option>
                {filters.branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>

        {rangeInvalid ? (
          <p role="alert" className="text-sm text-red-700">
            The start date must be on or before the end date.
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-2 text-xs text-fg-muted">
          <span>
            Showing <strong className="text-fg">{filters.rangeLabel}</strong> · {filters.scopeLabel}
          </span>
          <span>
            Compared with <strong className="text-fg">{filters.compareRangeLabel}</strong>
          </span>
          <span className="sm:ml-auto" role="status" aria-live="polite">
            {pending ? (
              <span className="inline-flex items-center gap-1.5 text-indigo-400">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Updating…
              </span>
            ) : (
              <>Updated {filters.updatedLabel}</>
            )}
          </span>
        </div>
      </section>

      <div
        aria-busy={pending}
        className={`space-y-5 transition-opacity duration-150 ${pending ? 'pointer-events-none opacity-50' : ''}`}
      >
        {children}
      </div>
    </div>
  );
}
