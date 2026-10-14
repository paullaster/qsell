'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, Loader2, X } from 'lucide-react';
import type { LookupOption } from '@/lib/lookup';
import { useAutocomplete, type UseAutocompleteOptions } from './useAutocomplete';

export interface AutocompleteProps {
  /** What the field is for. Always present for assistive technology; shown unless `hideLabel`. */
  label: string;
  hideLabel?: boolean;
  /** Id of the chosen option, or null. The caller owns the value. */
  value: string | null;
  /** How the chosen option is shown while the list is closed. */
  valueLabel?: string | null;
  onChange: (option: LookupOption | null) => void;
  /** Fetches one page of options for the typed text. Called only after the field is opened. */
  loadOptions: UseAutocompleteOptions['loadOptions'];
  /** Options fetched per request. */
  pageSize?: number;
  /** Pause after typing before searching, in milliseconds. */
  debounceMs?: number;
  /** The most options ever held at once; past it the person is asked to narrow the search. */
  maxOptions?: number;
  placeholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  required?: boolean;
  clearable?: boolean;
  /** Submits the chosen id with a form. */
  name?: string;
  id?: string;
  /** A problem with the current value, shown under the field. */
  error?: string | null;
  /** Where "Create new" goes. Meant to be an intercepted route, so a modal opens over this page. */
  createHref?: string;
  createLabel?: string;
  /** Where "View all" goes, for when the list is too long to browse here. */
  listHref?: string;
  listLabel?: string;
  className?: string;
}

const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_MAX_OPTIONS = 200;

/**
 * Picks one option from a list of any size. It never holds the whole list: it loads one page
 * when it is first opened, searches on the server as the person types, and loads further pages
 * as they scroll. It follows the ARIA combobox pattern and works by keyboard alone.
 */
export function Autocomplete({
  label,
  hideLabel = false,
  value,
  valueLabel = null,
  onChange,
  loadOptions,
  pageSize = DEFAULT_PAGE_SIZE,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  maxOptions = DEFAULT_MAX_OPTIONS,
  placeholder = 'Search…',
  emptyMessage = 'No matches',
  disabled = false,
  required = false,
  clearable = true,
  name,
  id,
  error = null,
  createHref,
  createLabel = 'Create new',
  listHref,
  listLabel = 'View all',
  className = '',
}: AutocompleteProps) {
  const uid = useId();
  const inputId = id ?? `${uid}-input`;
  const listId = `${uid}-list`;
  const statusId = `${uid}-status`;
  const errorId = `${uid}-error`;
  const optionId = (index: number) => `${uid}-option-${index}`;

  const { state, open, reset, setQuery, loadMore, retry, dispatch } = useAutocomplete({
    loadOptions,
    pageSize,
    debounceMs,
    maxOptions,
  });
  /** True once the person has typed, so the box shows their text rather than the chosen label. */
  const [typing, setTyping] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const sentinelRef = useRef<HTMLLIElement>(null);

  const showList = state.open && !disabled;
  const activeId = showList && state.active >= 0 ? optionId(state.active) : undefined;
  const text = typing ? state.query : (valueLabel ?? '');
  const hasMore = state.nextCursor !== null;

  // Keep the option the keyboard is on in view.
  useEffect(() => {
    if (activeId !== undefined) {
      document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
    }
  }, [activeId]);

  // Load the next page when the end of the list scrolls into view.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = listRef.current;
    if (!showList || !hasMore || !sentinel || !root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { root, rootMargin: '0px 0px 80px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [showList, hasMore, state.options.length, loadMore]);

  const finish = () => {
    setTyping(false);
    reset();
  };
  const choose = (option: LookupOption) => {
    onChange(option);
    finish();
  };
  const clear = () => {
    onChange(null);
    finish();
    inputRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (!state.open) open();
        else dispatch({ type: 'move', to: 'next' });
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (!state.open) open();
        else dispatch({ type: 'move', to: 'previous' });
        break;
      case 'Enter': {
        const option = showList ? state.options[state.active] : undefined;
        if (option) {
          event.preventDefault();
          choose(option);
        }
        break;
      }
      case 'Escape':
        if (state.open) {
          event.preventDefault();
          event.stopPropagation();
          finish();
        }
        break;
      default:
    }
  };

  const status = (() => {
    if (state.phase === 'loading') return 'Loading…';
    if (state.phase === 'error') return state.error ?? 'Could not load the list.';
    if (state.loadedFor === null) return '';
    if (state.options.length === 0) return emptyMessage;
    const count = `${state.options.length} ${state.options.length === 1 ? 'result' : 'results'}`;
    return state.capped ? `${count}. Type to narrow the search.` : count;
  })();

  return (
    <div
      ref={rootRef}
      className={`relative ${className}`}
      onBlur={(event) => {
        // Moving between the field and the list's own links keeps it open; leaving closes it.
        const inside = rootRef.current?.contains(event.relatedTarget) ?? false;
        if (!inside) finish();
      }}
    >
      <label
        htmlFor={inputId}
        className={hideLabel ? 'sr-only' : 'block text-sm font-medium text-fg'}
      >
        {label}
      </label>
      <div className={hideLabel ? '' : 'mt-1'}>
        <div className="relative">
          <input
            ref={inputRef}
            id={inputId}
            type="text"
            role="combobox"
            autoComplete="off"
            spellCheck={false}
            value={text}
            placeholder={placeholder}
            disabled={disabled}
            aria-required={required}
            aria-invalid={error !== null}
            aria-expanded={showList}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeId}
            aria-describedby={`${statusId}${error !== null ? ` ${errorId}` : ''}`}
            onFocus={open}
            onClick={open}
            onChange={(event) => {
              setTyping(true);
              setQuery(event.target.value);
            }}
            onKeyDown={onKeyDown}
            className="block min-h-10 w-full rounded-lg border border-line bg-surface py-2 pr-16 pl-3 text-fg-strong focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:opacity-60 aria-[invalid=true]:border-red-500"
          />
          <div className="absolute inset-y-0 right-1 flex items-center">
            {state.phase === 'loading' && (
              <Loader2 className="mr-1 h-4 w-4 animate-spin text-fg-muted" aria-hidden />
            )}
            {clearable && value !== null && !disabled && (
              <button
                type="button"
                onClick={clear}
                aria-label={`Clear ${label}`}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-fg-muted hover:bg-hover focus-visible:outline-2 focus-visible:outline-indigo-500"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            )}
            <ChevronDown className="mr-2 h-4 w-4 text-fg-muted" aria-hidden />
          </div>
        </div>

        {showList && (
          <div
            // Keeps focus in the field while the pointer works the list, so a click is not lost.
            onMouseDown={(event) => event.preventDefault()}
            className="absolute z-40 mt-1 w-full overflow-hidden rounded-xl border border-line bg-surface-raised shadow-xl"
          >
            <ul
              ref={listRef}
              id={listId}
              role="listbox"
              aria-label={label}
              aria-busy={state.phase !== 'idle'}
              className="max-h-72 overflow-y-auto overscroll-contain py-1"
            >
              {state.options.map((option, index) => (
                <li
                  key={option.id}
                  id={optionId(index)}
                  role="option"
                  aria-selected={option.id === value}
                  onMouseMove={() => state.active !== index && dispatch({ type: 'hover', index })}
                  onClick={() => choose(option)}
                  className={`flex min-h-11 cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm ${index === state.active ? 'bg-indigo-50 text-fg-strong dark:bg-indigo-500/20' : 'text-fg'} ${option.id === value ? 'font-semibold' : ''}`}
                >
                  <span className="min-w-0">
                    <span className="block truncate">{option.label}</span>
                    {option.description != null && option.description !== '' && (
                      <span className="block truncate text-xs text-fg-muted">
                        {option.description}
                      </span>
                    )}
                  </span>
                  {option.badge != null && option.badge !== '' && (
                    <span className="shrink-0 rounded-full bg-surface-sunken px-2 py-0.5 text-xs font-semibold text-fg">
                      {option.badge}
                    </span>
                  )}
                </li>
              ))}
              {hasMore && <li ref={sentinelRef} role="presentation" className="h-px" aria-hidden />}
            </ul>
            <div className="border-t border-line px-3 py-2 text-xs text-fg-muted">
              <p id={statusId} role="status" aria-live="polite">
                {status}
              </p>
              {state.phase === 'error' && (
                <button
                  type="button"
                  onClick={retry}
                  className="mt-1 min-h-9 rounded-md border border-line-strong px-3 py-1 font-medium text-fg hover:bg-hover"
                >
                  Try again
                </button>
              )}
              {hasMore && state.phase === 'idle' && (
                <button
                  type="button"
                  onClick={loadMore}
                  className="mt-1 min-h-9 rounded-md border border-line-strong px-3 py-1 font-medium text-fg hover:bg-hover"
                >
                  Load more
                </button>
              )}
            </div>
            {(createHref !== undefined || listHref !== undefined) && (
              <div className="flex flex-wrap gap-2 border-t border-line p-2">
                {createHref !== undefined && (
                  <Link
                    href={createHref}
                    prefetch={false}
                    scroll={false}
                    onClick={finish}
                    className="inline-flex min-h-10 items-center rounded-lg px-3 py-2 text-sm font-semibold text-indigo-700 hover:bg-hover focus-visible:outline-2 focus-visible:outline-indigo-500 dark:text-indigo-300"
                  >
                    + {createLabel}
                  </Link>
                )}
                {listHref !== undefined && (
                  <Link
                    href={listHref}
                    prefetch={false}
                    scroll={false}
                    onClick={finish}
                    className="inline-flex min-h-10 items-center rounded-lg px-3 py-2 text-sm font-medium text-fg hover:bg-hover focus-visible:outline-2 focus-visible:outline-indigo-500"
                  >
                    {listLabel}
                  </Link>
                )}
              </div>
            )}
          </div>
        )}
        {!showList && <p id={statusId} className="sr-only" />}
        {error !== null && (
          <p id={errorId} role="alert" className="mt-1 text-xs text-red-700">
            {error}
          </p>
        )}
      </div>
      {name !== undefined && <input type="hidden" name={name} value={value ?? ''} />}
    </div>
  );
}
