'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';
import { initialPagedState, pagedStateFrom, reducePaged } from './paged-list-state';

/** What a page request answers, as the server actions return it. */
export type PageResult<Row> =
  { ok: true; data: { rows: Row[]; nextCursor: string | null } } | { ok: false; error: string };

/**
 * Reads a list from the server a page at a time. The first page is read when the screen opens and
 * again whenever `filters` change; `loadMore` adds the next page; `reload` starts over. Only the
 * newest request's answer is used.
 */
export function usePagedList<Row, Filters extends object>(options: {
  load: (filters: Filters, cursor: string | null) => Promise<PageResult<Row>>;
  filters: Filters;
  /**
   * The first page for the starting filters, when the server already sent it with the screen: it
   * is shown at once and not fetched again. A change of filters fetches as usual.
   */
  initialPage?: PageResult<Row>;
}) {
  const [state, dispatch] = useReducer(reducePaged<Row>, options.initialPage, (page) =>
    page?.ok === true ? pagedStateFrom(page.data) : initialPagedState<Row>(),
  );
  const skipFirst = useRef(options.initialPage?.ok === true);
  const requestIds = useRef(0);
  const latest = useRef(options);
  const stateRef = useRef(state);
  useEffect(() => {
    latest.current = options;
    stateRef.current = state;
  });

  const fetchPage = useCallback((cursor: string | null) => {
    const requestId = ++requestIds.current;
    const append = cursor !== null;
    dispatch({ type: 'start', append, requestId });
    const { load, filters } = latest.current;
    load(filters, cursor).then(
      (result) => {
        if (result.ok) {
          dispatch({
            type: 'loaded',
            requestId,
            rows: result.data.rows,
            cursor: result.data.nextCursor,
            append,
          });
        } else {
          dispatch({ type: 'failed', requestId, message: result.error });
        }
      },
      (error: unknown) =>
        dispatch({
          type: 'failed',
          requestId,
          message: error instanceof Error ? error.message : 'Could not load the list.',
        }),
    );
  }, []);

  const filterKey = JSON.stringify(options.filters);
  useEffect(() => {
    if (skipFirst.current) {
      skipFirst.current = false;
      return;
    }
    fetchPage(null);
  }, [filterKey, fetchPage]);

  const loadMore = useCallback(() => {
    const { cursor, phase } = stateRef.current;
    if (cursor !== null && phase !== 'more' && phase !== 'loading') fetchPage(cursor);
  }, [fetchPage]);
  const retry = useCallback(() => fetchPage(stateRef.current.cursor), [fetchPage]);
  const reload = useCallback(() => fetchPage(null), [fetchPage]);

  return { ...state, loadMore, retry, reload };
}
