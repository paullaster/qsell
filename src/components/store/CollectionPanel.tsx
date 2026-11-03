'use client';

import { KeyRound, MapPin, Phone, RefreshCw } from 'lucide-react';
import type { CollectionState } from '@/components/store/useCollection';

const STATUS_WORDS: Record<string, string> = {
  waiting: 'We are getting your order ready.',
  ready: 'Your order is ready. Come and collect it.',
  collected: 'You have collected this order.',
  locked: 'The code was typed wrongly too many times. Ask the branch for a new code.',
  cancelled: 'This order was cancelled.',
};

/** Where to collect an order and the code to show at the counter. Nothing is drawn for an order that is delivered. */
export function CollectionPanel({ state, onRefresh }: { state: CollectionState; onRefresh: () => void }) {
  // Most orders are delivered, so nothing is said while it is found out whether this one is collected.
  if (state.phase === 'loading' || state.phase === 'none') return null;
  if (state.phase === 'error') {
    return (
      <p role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
        {state.error}
      </p>
    );
  }
  const { view, code } = state.collection;
  return (
    <section aria-label="Collect your order" className="space-y-3 rounded-xl border border-indigo-500/30 bg-indigo-600/5 p-4">
      <h2 className="flex items-center gap-2 text-xs font-semibold tracking-wider text-fg-muted uppercase">
        <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
        Collect your order
      </h2>
      <div className="space-y-0.5 text-sm">
        <p className="font-semibold text-fg-strong">{view.branch.name}</p>
        {view.branch.address === '' ? null : (
          <p className="flex items-start gap-1.5 text-fg-muted">
            <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="break-words">{view.branch.address}</span>
          </p>
        )}
        {view.branch.phone === null ? null : (
          <p className="flex items-center gap-1.5 text-fg-muted">
            <Phone className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {view.branch.phone}
          </p>
        )}
      </div>
      {code === null ? null : (
        <div>
          <p className="text-xs text-fg-muted">Show this code at the counter. It works once, so keep it to yourself.</p>
          <p aria-label={`Collection code ${code.split('').join(' ')}`} className="mt-1 font-mono text-3xl font-bold tracking-widest text-fg-strong">
            {code}
          </p>
        </div>
      )}
      <p role="status" className="text-sm text-fg">
        {STATUS_WORDS[view.status] ?? ''}
      </p>
      <button type="button" onClick={onRefresh} className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-line-strong bg-surface-raised px-4 text-sm font-semibold text-fg-strong hover:bg-hover">
        <RefreshCw className="h-4 w-4" aria-hidden="true" />
        Check again
      </button>
    </section>
  );
}
