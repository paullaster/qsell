'use client';

import type { PriceTrace } from '@/server/domains/pricing/domain/types';
import { PriceTraceView } from './PriceTraceView';

/** Under a quote line's price: where the price came from, why, and how to change the source. */
export function QuoteLinePriceNote({
  mode,
  trace,
  problem,
  onUseLists,
}: {
  mode: 'catalog' | 'manual' | 'kept';
  trace?: PriceTrace | null;
  problem?: string | null;
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
      <span>{source}</span>
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
