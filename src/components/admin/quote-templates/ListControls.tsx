'use client';

import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { LookupAutocomplete } from '@/components/ui/autocomplete/LookupAutocomplete';
import { templateStatusLabel, type TemplateStatusFilter } from '@/lib/template-statuses';

const SEARCH_PAUSE_MS = 300;

/** Search text and a status for a template list; the text is passed on after a pause in typing. */
export function ListFilters({
  noun,
  onChange,
}: {
  /** What the list holds, for the labels: "templates", "section templates". */
  noun: string;
  onChange: (filters: { query: string; status: TemplateStatusFilter }) => void;
}) {
  const [text, setText] = useState('');
  const [status, setStatus] = useState<TemplateStatusFilter>('all');

  useEffect(() => {
    const timer = setTimeout(() => onChange({ query: text.trim(), status }), SEARCH_PAUSE_MS);
    return () => clearTimeout(timer);
    // `onChange` is called with the values, so a new function identity must not restart the pause.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, status]);

  return (
    <div className="flex flex-col gap-3 border-b border-line p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="relative w-full sm:max-w-sm">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-fg-subtle"
          aria-hidden
        />
        <input
          type="search"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={`Search ${noun}…`}
          aria-label={`Search ${noun}`}
          className="min-h-10 w-full rounded-lg border border-line bg-surface py-2 pr-3 pl-9 text-sm text-fg-strong placeholder:text-fg-subtle focus-visible:outline-2 focus-visible:outline-indigo-500"
        />
      </div>
      <LookupAutocomplete
        source="template-statuses"
        label={`Filter ${noun} by status`}
        hideLabel
        value={status}
        valueLabel={templateStatusLabel(status)}
        clearable={false}
        onChange={(option) => {
          if (option !== null) setStatus(option.id as TemplateStatusFilter);
        }}
        className="w-full sm:w-56"
      />
    </div>
  );
}

/** Under a paged list: how many are shown, any error, and the button for the next page. */
export function ListFooter({
  shown,
  noun,
  hasMore,
  loadingMore,
  error,
  onLoadMore,
  onRetry,
}: {
  shown: number;
  noun: string;
  hasMore: boolean;
  loadingMore: boolean;
  error: string | null;
  onLoadMore: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line p-3 text-xs text-fg-muted">
      <p role="status" aria-live="polite">
        {String(shown)} {noun} shown
        {hasMore ? ', more available' : ''}
      </p>
      {error !== null && (
        <p role="alert" className="flex items-center gap-2 text-red-700">
          {error}
          <button
            type="button"
            onClick={onRetry}
            className="min-h-9 rounded-md border border-line-strong px-3 py-1 font-medium text-fg hover:bg-hover"
          >
            Try again
          </button>
        </p>
      )}
      {hasMore && (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={loadingMore}
          className="min-h-10 rounded-lg border border-line-strong bg-surface px-4 py-2 text-sm font-medium text-fg hover:bg-hover focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:opacity-50"
        >
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}
