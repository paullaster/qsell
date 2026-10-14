/**
 * The state of a list that is read from the server a page at a time, as a pure reducer: which
 * response is current, how pages join, and what an error leaves on screen. The hook feeds it
 * events; the screen only draws it.
 */
export type ListPhase = 'loading' | 'idle' | 'more' | 'error';

export interface PagedState<Row> {
  rows: Row[];
  /** Ask for the next page with this; null when there are no more. */
  cursor: string | null;
  phase: ListPhase;
  error: string | null;
  /** The newest request; an answer for any other is stale and ignored. */
  requestId: number;
}

export const initialPagedState = <Row>(): PagedState<Row> => ({
  rows: [],
  cursor: null,
  phase: 'loading',
  error: null,
  requestId: 0,
});

/** The state when the first page is already in hand (the server sent it with the screen). */
export const pagedStateFrom = <Row>(page: {
  rows: Row[];
  nextCursor: string | null;
}): PagedState<Row> => ({
  rows: page.rows,
  cursor: page.nextCursor,
  phase: 'idle',
  error: null,
  requestId: 0,
});

export type PagedEvent<Row> =
  | { type: 'start'; append: boolean; requestId: number }
  | { type: 'loaded'; requestId: number; rows: Row[]; cursor: string | null; append: boolean }
  | { type: 'failed'; requestId: number; message: string };

export function reducePaged<Row>(state: PagedState<Row>, event: PagedEvent<Row>): PagedState<Row> {
  switch (event.type) {
    case 'start':
      // A new first page keeps what is shown until it arrives, so the list does not flash empty.
      return {
        ...state,
        phase: event.append ? 'more' : 'loading',
        error: null,
        requestId: event.requestId,
      };
    case 'loaded':
      if (event.requestId !== state.requestId) return state;
      return {
        ...state,
        rows: event.append ? [...state.rows, ...event.rows] : event.rows,
        cursor: event.cursor,
        phase: 'idle',
        error: null,
      };
    case 'failed':
      if (event.requestId !== state.requestId) return state;
      return { ...state, phase: 'error', error: event.message };
  }
}
