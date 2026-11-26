'use client';

import { useState } from 'react';
import { comeBackAction, startReconcilingAction, unloadVanAction, type DayScreen } from '@/server/domains/van-sales/actions';
import { cardClass, primaryClass } from '@/components/ui/screen-kit';
import type { DayCall } from './call';

function vanWords(unload: string, onVan: number): string {
  if (unload !== 'none') return 'The van has been unloaded.';
  if (onVan === 0) return 'The van is empty.';
  return `${String(onVan)} ${onVan === 1 ? 'product is' : 'products are'} still on the van.`;
}

/** The end of the day: the rep says they are back, unloads the van, and the office starts settling the day. Each step says what is in the way when it cannot be taken. */
export function EndPanel({ screen, run }: { screen: DayScreen; run: DayCall }) {
  const [busy, setBusy] = useState(false);
  const { day } = screen.detail;
  const { end } = screen;
  const repMay = screen.isRep && screen.maySell;
  const go = async (call: Parameters<DayCall>[0], text: string) => {
    setBusy(true);
    await run(call, text);
    setBusy(false);
  };
  if (day.status === 'out' && repMay) {
    return (
      <section className={`${cardClass} space-y-3`} aria-label="End of the day">
        <h2 className="text-base font-bold text-fg-strong">End of the day</h2>
        {end.backProblem === null ? null : <p className="text-sm text-fg-muted" data-testid="back-problem">{end.backProblem}</p>}
        <button type="button" className={`${primaryClass} min-h-11`} disabled={busy || end.backProblem !== null} onClick={() => void go(comeBackAction({ dayId: day.id, expectedVersion: day.version }), 'You are back. Unload the van next.')}>I am back at the depot</button>
      </section>
    );
  }
  if (day.status === 'returning') {
    const mayStart = screen.mayReconcile;
    return (
      <section className={`${cardClass} space-y-3`} aria-label="End of the day">
        <h2 className="text-base font-bold text-fg-strong">End of the day</h2>
        {day.vanId === null ? null : <p className="text-sm text-fg-muted">{vanWords(end.unload, end.onVan)}</p>}
        {repMay && end.unload === 'none' && end.unloadProblem === null ? <button type="button" className={`${primaryClass} min-h-11`} disabled={busy} onClick={() => void go(unloadVanAction({ dayId: day.id }), 'The van is being unloaded.')}>Unload the van</button> : null}
        {mayStart ? (
          <div className="space-y-2">
            {end.reconcileProblem === null ? null : <p className="text-sm text-fg-muted" data-testid="reconcile-problem">{end.reconcileProblem}</p>}
            <button type="button" className={`${primaryClass} min-h-11`} disabled={busy || end.reconcileProblem !== null} onClick={() => void go(startReconcilingAction({ dayId: day.id }), 'The day is ready to be settled.')}>Start settling the day</button>
          </div>
        ) : null}
      </section>
    );
  }
  return null;
}
