'use client';

import { Modal } from '@/components/ui/Modal';
import type { HeldSaleRow } from '@/server/domains/selling/cash-sales/held-sale-service';

/** The sales set aside at this till: bring one back or give it up. */
export function HeldDialog({ rows, busy, problem, onRecall, onDiscard, onClose }: { rows: HeldSaleRow[]; busy: boolean; problem: string | null; onRecall: (id: string) => void; onDiscard: (id: string) => void; onClose: () => void }) {
  return (
    <Modal title="Sales on hold" onClose={onClose}>
      {rows.length === 0 ? <p className="text-sm text-fg-muted" data-testid="held-empty">Nothing is on hold. Press Hold on a sale to set it aside while you serve someone else.</p> : (
        <ul className="space-y-2" data-testid="held-list">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line p-3" data-testid="held-row">
              <div className="min-w-0">
                <p className="font-semibold text-fg-strong">{r.label} · {r.lineCount} line{r.lineCount === 1 ? '' : 's'}</p>
                <p className="text-sm break-words text-fg-muted">{r.preview.join(', ')}{r.lineCount > r.preview.length ? '…' : ''}</p>
              </div>
              <div className="flex gap-2">
                <button type="button" className="inline-flex min-h-11 items-center rounded-lg bg-indigo-600 px-4 text-sm font-bold text-white hover:bg-indigo-500 disabled:opacity-50" disabled={busy} onClick={() => onRecall(r.id)} aria-label={`Bring back ${r.label}`}>Bring back</button>
                <button type="button" className="inline-flex min-h-11 items-center rounded-lg border border-line px-4 text-sm font-semibold text-fg hover:bg-hover disabled:opacity-50" disabled={busy} onClick={() => onDiscard(r.id)} aria-label={`Give up ${r.label}`}>Give up</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {problem === null ? null : <p role="alert" className="mt-3 text-sm text-red-700">{problem}</p>}
    </Modal>
  );
}
