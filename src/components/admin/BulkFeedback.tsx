'use client';

import React, { useEffect } from 'react';
import { Loader2 } from 'lucide-react';

export interface BulkNotice {
  tone: 'ok' | 'warn' | 'error';
  text: string;
  details: string[];
}

/** Warns before leaving the page while a bulk change is running. */
export function useWarnBeforeLeaving(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [active]);
}

/** Covers the page while a bulk change runs, so nothing can be clicked twice. */
export function BusyOverlay({ text }: { text: string }) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4">
      <div
        role="status"
        aria-live="polite"
        className="flex max-w-sm items-center gap-3 rounded-xl border border-line bg-surface-raised p-4 shadow-2xl"
      >
        <Loader2 className="h-6 w-6 shrink-0 animate-spin text-indigo-600" aria-hidden="true" />
        <div>
          <p className="text-sm font-semibold text-fg-strong">{text}</p>
          <p className="text-xs text-fg-muted">Please keep this page open until it finishes.</p>
        </div>
      </div>
    </div>
  );
}

/** How a bulk change ended, with the products it could not handle listed. */
export function ResultNotice({ notice, onDismiss }: { notice: BulkNotice; onDismiss: () => void }) {
  return (
    <div
      role={notice.tone === 'error' ? 'alert' : 'status'}
      className={`flex items-start justify-between gap-3 rounded-xl border p-4 text-sm ${
        notice.tone === 'error'
          ? 'border-red-600/40 bg-red-500/10 text-red-700 dark:text-red-300'
          : notice.tone === 'warn'
            ? 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200'
            : 'border-emerald-600/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200'
      }`}
    >
      <div>
        <p className="font-semibold">{notice.text}</p>
        {notice.details.length > 0 ? (
          <ul className="mt-1 max-h-40 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs">
            {notice.details.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="min-h-9 shrink-0 cursor-pointer rounded px-2 text-xs font-semibold underline hover:no-underline"
      >
        Dismiss
      </button>
    </div>
  );
}
