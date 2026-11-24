'use client';

import { useRef, useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { SegmentedChoice } from '@/components/ui/SegmentedChoice';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { t } from '@/lib/reports/messages';

export interface FilterState {
  preset: string;
  compare: string;
  /** The chosen branch's id and name, or null for every branch. */
  branch: { id: string; name: string } | null;
  fromDate: string;
  toDate: string;
  rangeLabel: string;
  compareRangeLabel: string;
  scopeLabel: string;
  updatedLabel: string;
  presets: readonly { value: string; label: string }[];
  compareModes: readonly { value: string; label: string }[];
  /** True only for people who may choose a branch (they may run reports across every branch). */
  canPickBranch: boolean;
}

const dateField =
  'min-h-11 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong focus:border-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40';

/**
 * The two date boxes. Dates being typed live here until they form a valid range. The parent gives this component a new
 * `key` whenever the address changes (a click, Back, Forward), which starts it afresh from what the report shows: no
 * effect is needed to copy the address into the boxes.
 */
function DateRangeFields({
  fromDate,
  toDate,
  onApply,
}: {
  fromDate: string;
  toDate: string;
  onApply: (from: string, to: string) => void;
}) {
  const [from, setFrom] = useState(fromDate);
  const [to, setTo] = useState(toDate);
  const invalid = from !== '' && to !== '' && from > to;

  const change = (nextFrom: string, nextTo: string) => {
    setFrom(nextFrom);
    setTo(nextTo);
    if (nextFrom !== '' && nextTo !== '' && nextFrom <= nextTo) onApply(nextFrom, nextTo);
  };

  return (
    <>
      <label className="block text-xs font-semibold text-fg-subtle">
        From
        <input
          type="date"
          value={from}
          max={to === '' ? undefined : to}
          onChange={(e) => {
            change(e.target.value, to);
          }}
          className={`${dateField} mt-1`}
          aria-invalid={invalid}
        />
      </label>
      <label className="block text-xs font-semibold text-fg-subtle">
        To
        <input
          type="date"
          value={to}
          min={from === '' ? undefined : from}
          onChange={(e) => {
            change(from, e.target.value);
          }}
          className={`${dateField} mt-1`}
          aria-invalid={invalid}
        />
      </label>
      {invalid ? (
        <p role="alert" className="text-sm text-red-700 sm:col-span-2 lg:col-span-4">
          The start date must be on or before the end date.
        </p>
      ) : null}
    </>
  );
}

/**
 * The filters of a report. Every control applies at once: it writes the address (so a view can be shared and the Back
 * button undoes it) and the server draws the new figures. The control changes immediately; the figures underneath are dimmed
 * and marked "Updating" until the answer for the new choice arrives, so an old figure is never shown as the answer to a new
 * question. Nothing here is a native select: the compare choice is a short segmented choice and the branch is a searched list.
 */
export function FilterBar({
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
      router.push(qs === '' ? pathname : `${pathname}?${qs}`, { scroll: false });
    });
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
                onClick={() => {
                  apply({ period: p.value, from: null, to: null });
                }}
                className={`min-h-10 rounded-full border px-3.5 py-1.5 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-indigo-500 active:scale-[0.97] ${
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

        <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <DateRangeFields
            key={`${filters.fromDate}|${filters.toDate}|${params.toString()}`}
            fromDate={filters.fromDate}
            toDate={filters.toDate}
            onApply={(from, to) => {
              apply({ period: 'custom', from, to });
            }}
          />
          <SegmentedChoice
            label="Compare with"
            value={filters.compare}
            options={filters.compareModes}
            onChange={(value) => {
              apply({ compare: value });
            }}
          />
          {filters.canPickBranch ? (
            <ChoicePicker
              label="Branch"
              source="report-branches"
              choice={
                filters.branch === null
                  ? null
                  : { id: filters.branch.id, label: filters.branch.name }
              }
              onChoice={(choice) => {
                apply({ branch: choice === null ? null : choice.id });
              }}
              placeholder="All branches"
              clearable
            />
          ) : null}
        </div>

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
                <Loader2 className="size-3.5 animate-spin" aria-hidden /> {t('common.updating')}
              </span>
            ) : (
              t('common.updated', { time: filters.updatedLabel })
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
