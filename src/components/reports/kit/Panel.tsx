import { OctagonAlert } from 'lucide-react';
import { t } from '@/lib/reports/messages';

/**
 * A titled box for one part of a report. It says what the numbers mean in one plain sentence, so a figure is never
 * left unexplained. Each panel loads and fails by itself: one slow or broken part never blanks the page.
 */
export function Panel({
  id,
  title,
  definition,
  actions,
  children,
}: {
  id: string;
  title: string;
  /** One plain sentence saying exactly what the numbers mean. */
  definition?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="min-w-0 space-y-4 rounded-xl border border-line bg-surface-raised p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id={id} className="text-sm font-bold text-fg-strong">
            {title}
          </h2>
          {definition !== undefined ? (
            <p className="mt-0.5 text-xs text-fg-muted">{definition}</p>
          ) : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** What shows while a panel's data is on its way: the same shape as the finished panel, so nothing jumps when it arrives. */
export function PanelSkeleton({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className="min-w-0 space-y-3 rounded-xl border border-line bg-surface-raised p-4 sm:p-5"
    >
      <span className="sr-only">Loading {label}…</span>
      <div className="h-4 w-40 animate-pulse rounded bg-pulse" />
      {Array.from({ length: rows }, (_, i) => `row-${String(i)}`).map((key) => (
        <div key={key} className="h-16 animate-pulse rounded-lg bg-pulse" />
      ))}
    </div>
  );
}

/** A panel with nothing to show, and what to do about it. */
export function EmptyPanel({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-sm text-fg-muted"
      data-testid="empty-panel"
    >
      {children}
    </p>
  );
}

/** A panel that could not load, with the way to try again. */
export function FailedPanel({ name, onRetry }: { name: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-red-800 bg-red-50 px-3 py-3 text-sm text-red-800"
    >
      <OctagonAlert className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">{name} could not be loaded just now.</span>
      {onRetry === undefined ? null : (
        <button
          type="button"
          onClick={onRetry}
          className="min-h-10 rounded-lg border border-red-800 px-3 font-semibold hover:bg-red-100 focus-visible:outline-2 focus-visible:outline-red-800"
        >
          {t('common.try_again')}
        </button>
      )}
    </div>
  );
}
