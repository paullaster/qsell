'use client';

import type { DayScreen } from '@/server/domains/van-sales/actions';
import { cardClass } from '@/components/ui/screen-kit';
import type { DayCall } from './call';
import { LoadCard } from './LoadCard';
import { LoadPlanner } from './LoadPlanner';

/** Loading the van: the loads made up for the day, the planner for the next one, and what is on the van now. A day with no van has none of this. */
export function LoadPanel({ screen, run }: { screen: DayScreen; run: DayCall }) {
  const { day } = screen.detail;
  if (day.vanId === null) return null;
  const { loads, onVan, suggestion } = screen;
  return (
    <div className="space-y-5">
      {loads.length === 0 ? null : (
        <section className="space-y-3" aria-label="Loads">
          <h2 className="text-base font-bold text-fg-strong">Loads</h2>
          <ul className="space-y-3" aria-label="Loads of the day">
            {loads.map((l) => <LoadCard key={l.id} load={l} screen={screen} run={run} />)}
          </ul>
        </section>
      )}
      {suggestion === null ? null : <LoadPlanner key={`${day.version}-${String(loads.length)}`} screen={screen} suggestion={suggestion} run={run} />}
      <section className={`${cardClass} space-y-2`} aria-label="On the van now">
        <h2 className="text-base font-bold text-fg-strong">On the van now</h2>
        {onVan.length === 0 ? (
          <p role="status" className="text-sm text-fg-muted">Nothing is on the van yet. Stock arrives when the rep signs for a load.</p>
        ) : (
          <ul className="space-y-1 text-sm" aria-label="Stock on the van">
            {onVan.map((r) => (
              <li key={r.productId} className="flex flex-wrap gap-x-3">
                <span className="font-semibold">{r.productName}</span>{' '}
                <span className="text-fg-muted">{r.onHand} {r.unitName}{r.reserved > 0 ? ` · ${String(r.reserved)} promised` : ''}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
