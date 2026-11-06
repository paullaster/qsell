import { X } from 'lucide-react';
import type { Replaced } from './useLineReplace';

/** Says what was swapped and offers one click to put it back. */
export function ReplacedNotice({ replaced, detail, onUndo, onDismiss }: { replaced: Replaced<unknown>; detail: string; onUndo: () => void; onDismiss: () => void }) {
  return (
    <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200">
      <span>
        Replaced {replaced.fromName} with {replaced.toName}. {detail}
      </span>
      <span className="flex gap-2">
        <button type="button" onClick={onUndo} className="min-h-10 cursor-pointer rounded-lg border border-emerald-400 px-3 font-semibold hover:bg-emerald-100 dark:hover:bg-emerald-900/40">Undo</button>
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="min-h-10 min-w-10 cursor-pointer rounded-lg px-2 hover:bg-emerald-100 dark:hover:bg-emerald-900/40"><X className="mx-auto h-4 w-4" aria-hidden /></button>
      </span>
    </div>
  );
}
