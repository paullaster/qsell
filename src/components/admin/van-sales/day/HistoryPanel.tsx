'use client';

import { useWhen } from '@/components/business-time';
import { cardClass } from '@/components/ui/screen-kit';
import type { EventView } from '@/server/domains/van-sales/days';

/** What has happened to the day, oldest first, each with the time it happened, who did it and why. */
export function HistoryPanel({ events }: { events: EventView[] }) {
  const when = useWhen();
  return (
    <section className={`${cardClass} space-y-3`} aria-label="History of the day">
      <h2 className="text-base font-bold text-fg-strong">History</h2>
      <ol className="space-y-2" aria-label="History">
        {events.map((e) => (
          <li key={e.id} className="rounded-lg border border-line p-3 text-sm">
            <p className="font-semibold text-fg-strong">{e.words}</p>
            <p className="text-xs text-fg-muted">{when(e.at)}{e.by === null ? '' : ` · ${e.by}`}</p>
            {e.reason === null ? null : <p className="text-xs text-fg-muted">Because: {e.reason}</p>}
          </li>
        ))}
      </ol>
    </section>
  );
}
