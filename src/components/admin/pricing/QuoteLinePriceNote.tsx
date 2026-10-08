'use client';

import type { GuardTrace, PriceTrace } from '@/server/domains/pricing/domain/types';
import { PriceTraceView } from './PriceTraceView';

/** Under a quote line's price: where the price came from, why, and how to change the source. */
export function QuoteLinePriceNote({
  mode,
  trace,
  problem,
  guard,
  onUseLists,
}: {
  mode: 'catalog' | 'manual' | 'kept';
  trace?: PriceTrace | null;
  problem?: string | null;
  /** What the price floor and override limit checks found for this line. */
  guard?: GuardTrace | null;
  onUseLists: () => void;
}) {
  if (problem)
    return (
      <p role="alert" className="mt-1 max-w-48 text-xs text-red-700">
        {problem}
      </p>
    );
  const source =
    mode === 'manual'
      ? 'Typed price'
      : mode === 'kept'
        ? 'Saved price'
        : trace?.source === 'price_list'
          ? `From ${trace.winner?.listCode}`
          : trace?.source === 'standard'
            ? 'Standard price'
            : 'Pricing…';
  return (
    <div className="mt-1 max-w-48 text-xs text-fg-muted">
      <GuardNotes guard={guard} />
      <span>{source}</span>
      {mode === 'catalog' && trace?.discounts && trace.discounts.applied.length > 0 ? (
        <span className="ml-1 text-emerald-700">
          · {trace.discounts.applied.map((a) => a.code).join(', ')} (−
          {trace.discounts.applied.reduce((n, a) => n + a.amount, 0).toFixed(2)})
        </span>
      ) : null}
      {mode !== 'catalog' ? (
        <button
          type="button"
          onClick={onUseLists}
          className="ml-2 inline-flex min-h-8 cursor-pointer items-center text-indigo-700 underline hover:no-underline focus-visible:outline-2 focus-visible:outline-indigo-500"
        >
          {mode === 'kept' ? 'Reprice' : 'Use price list'}
        </button>
      ) : null}
      {mode === 'catalog' && trace ? (
        <details className="mt-0.5">
          <summary className="inline-flex min-h-8 cursor-pointer items-center text-indigo-700">
            Why this price?
          </summary>
          <div className="mt-1 w-72 max-w-[80vw] rounded-lg border border-line bg-surface p-2 text-fg">
            <PriceTraceView trace={trace} showCandidates={false} />
          </div>
        </details>
      ) : null}
    </div>
  );
}

/** Warnings from the price floor and override limit, in plain words. */
function GuardNotes({ guard }: { guard?: GuardTrace | null }) {
  if (!guard || (!guard.belowFloor && !guard.overOverrideLimit)) return null;
  return (
    <div
      role="status"
      className="mb-1 space-y-0.5 rounded border border-amber-500/40 bg-amber-500/10 p-1.5 text-amber-800 dark:text-amber-200"
    >
      {guard.belowFloor ? (
        <p>
          {guard.enforcement === 'block'
            ? `Below the price floor of ${guard.floorNet?.toFixed(2)} (before tax). This cannot be saved.`
            : `${guard.shortfallPercent}% below the price floor of ${guard.floorNet?.toFixed(2)} (before tax). The quote will need approval.`}
        </p>
      ) : null}
      {guard.overOverrideLimit ? (
        <p>
          Price is {guard.overridePercent}% below list; your limit is {guard.overrideLimitPercent}%.
          The quote will need approval.
        </p>
      ) : null}
    </div>
  );
}
