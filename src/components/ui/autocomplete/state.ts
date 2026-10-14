import type { LookupOption, LookupPage } from '@/lib/lookup';

/**
 * The Autocomplete's state as a pure reducer, so every rule about it can be tested without a
 * browser: what loads when, which responses are stale, how far the list may grow, and which option
 * the keyboard is on. The hook feeds it events; the component only draws it.
 */
export type Phase = 'idle' | 'loading' | 'more' | 'error';

export interface AutocompleteState {
  open: boolean;
  /** What the person has typed to search with. */
  query: string;
  options: LookupOption[];
  nextCursor: string | null;
  phase: Phase;
  error: string | null;
  /** Index of the option the keyboard is on, or -1. */
  active: number;
  /** Id of the newest request (issued by the caller); a response for any other is stale and ignored. */
  requestId: number;
  /** The query the options on screen were loaded for, or null before anything has loaded. */
  loadedFor: string | null;
  /** More matched than the list may hold, so the person is pointed to narrow the search. */
  capped: boolean;
}

export const initialState: AutocompleteState = {
  open: false,
  query: '',
  options: [],
  nextCursor: null,
  phase: 'idle',
  error: null,
  active: -1,
  requestId: 0,
  loadedFor: null,
  capped: false,
};

export type AutocompleteEvent =
  | { type: 'open' }
  | { type: 'close' }
  /** Forget everything loaded, as after a choice is made: the next open loads afresh. */
  | { type: 'reset'; requestId: number }
  | { type: 'type'; query: string; requestId: number }
  | { type: 'fetch'; append: boolean; requestId: number }
  | { type: 'loaded'; requestId: number; page: LookupPage; append: boolean; maxOptions: number }
  | { type: 'failed'; requestId: number; message: string }
  | { type: 'move'; to: 'next' | 'previous' | 'first' | 'last' }
  | { type: 'hover'; index: number };

export function reduce(state: AutocompleteState, event: AutocompleteEvent): AutocompleteState {
  switch (event.type) {
    case 'open':
      return state.open ? state : { ...state, open: true };
    case 'close':
      // The request in flight no longer matters: its answer would reopen nothing, but must not
      // overwrite a list the person has since started over.
      return { ...state, open: false, active: -1 };
    case 'reset':
      return { ...initialState, requestId: event.requestId };
    case 'type':
      // New text starts a new search: what was loaded is no longer for it, and any answer still
      // on its way (an older request id) must not land.
      return {
        ...state,
        open: true,
        query: event.query,
        loadedFor: null,
        nextCursor: null,
        active: -1,
        capped: false,
        requestId: event.requestId,
      };
    case 'fetch': {
      const keep = event.append;
      return {
        ...state,
        phase: keep ? 'more' : 'loading',
        error: null,
        requestId: event.requestId,
        options: keep ? state.options : [],
        nextCursor: keep ? state.nextCursor : null,
        active: keep ? state.active : -1,
        capped: keep ? state.capped : false,
      };
    }
    case 'loaded': {
      if (event.requestId !== state.requestId) return state;
      const merged = event.append ? [...state.options, ...event.page.options] : event.page.options;
      // Never hold more than `maxOptions` however far the person scrolls: past that they are
      // asked to narrow the search instead of the list growing without bound.
      const capped = merged.length >= event.maxOptions && event.page.nextCursor !== null;
      const options = merged.length > event.maxOptions ? merged.slice(0, event.maxOptions) : merged;
      const firstActive = options.length > 0 ? 0 : -1;
      return {
        ...state,
        options,
        nextCursor: capped ? null : event.page.nextCursor,
        capped,
        phase: 'idle',
        error: null,
        loadedFor: state.query,
        active: event.append ? state.active : firstActive,
      };
    }
    case 'failed':
      if (event.requestId !== state.requestId) return state;
      return { ...state, phase: 'error', error: event.message };
    case 'move':
      return state.options.length === 0
        ? state
        : { ...state, active: movedTo(state, event.to), open: true };
    case 'hover':
      return event.index >= 0 && event.index < state.options.length
        ? { ...state, active: event.index }
        : state;
  }
}

/** Where the keyboard goes: the first or last option, or one step on, wrapping at the ends. */
function movedTo(state: AutocompleteState, to: 'next' | 'previous' | 'first' | 'last'): number {
  const last = state.options.length - 1;
  if (to === 'first') return 0;
  if (to === 'last') return last;
  if (to === 'next') return state.active >= last ? 0 : state.active + 1;
  return state.active <= 0 ? last : state.active - 1;
}

/** True when opening should start the first load: nothing has loaded for the current text yet. */
export const needsFirstLoad = (state: AutocompleteState): boolean =>
  state.loadedFor === null && state.phase !== 'loading';

/** True when scrolling to the end should load another page. */
export const canLoadMore = (state: AutocompleteState): boolean =>
  state.open && state.nextCursor !== null && state.phase === 'idle' && !state.capped;
