'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { LookupPage } from '@/lib/lookup';
import { canLoadMore, initialState, needsFirstLoad, reduce } from './state';

export interface LoadRequest {
  query: string;
  cursor: string | null;
  limit: number;
}

export interface UseAutocompleteOptions {
  loadOptions: (request: LoadRequest) => Promise<LookupPage>;
  pageSize: number;
  debounceMs: number;
  maxOptions: number;
}

/**
 * Runs the Autocomplete: nothing loads until it is opened; typing searches after a short pause;
 * only the newest request's answer is used; and more is loaded a page at a time. The rules live in
 * the pure reducer; this only connects them to timers and the request.
 */
export function useAutocomplete(options: UseAutocompleteOptions) {
  const [state, dispatch] = useReducer(reduce, initialState);
  const stateRef = useRef(state);
  const optionsRef = useRef(options);
  const requestIds = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    stateRef.current = state;
    optionsRef.current = options;
  });
  useEffect(() => () => clearTimeout(timer.current), []);

  const load = useCallback((query: string, cursor: string | null, append: boolean) => {
    const requestId = ++requestIds.current;
    dispatch({ type: 'fetch', append, requestId });
    const { loadOptions, pageSize, maxOptions } = optionsRef.current;
    loadOptions({ query, cursor, limit: pageSize }).then(
      (page) => dispatch({ type: 'loaded', requestId, page, append, maxOptions }),
      (error: unknown) =>
        dispatch({
          type: 'failed',
          requestId,
          message: error instanceof Error ? error.message : 'Could not load the list.',
        }),
    );
  }, []);

  /** Opens the list; the first page loads now, and only now, if it has not loaded yet. */
  const open = useCallback(() => {
    dispatch({ type: 'open' });
    const current = stateRef.current;
    if (needsFirstLoad(current)) load(current.query, null, false);
  }, [load]);

  const close = useCallback(() => {
    clearTimeout(timer.current);
    dispatch({ type: 'close' });
  }, []);

  /** Forgets the search and what was loaded, as after a choice. */
  const reset = useCallback(() => {
    clearTimeout(timer.current);
    dispatch({ type: 'reset', requestId: ++requestIds.current });
  }, []);

  const setQuery = useCallback(
    (query: string) => {
      clearTimeout(timer.current);
      dispatch({ type: 'type', query, requestId: ++requestIds.current });
      timer.current = setTimeout(() => load(query, null, false), optionsRef.current.debounceMs);
    },
    [load],
  );

  const loadMore = useCallback(() => {
    const current = stateRef.current;
    if (canLoadMore(current) && current.nextCursor !== null) {
      load(current.query, current.nextCursor, true);
    }
  }, [load]);

  /** After a failure: tries the same step again. */
  const retry = useCallback(() => {
    const current = stateRef.current;
    if (current.options.length > 0 && current.nextCursor !== null) {
      load(current.query, current.nextCursor, true);
    } else {
      load(current.query, null, false);
    }
  }, [load]);

  return { state, dispatch, open, close, reset, setQuery, loadMore, retry };
}
