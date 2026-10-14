import { describe, expect, it } from 'vitest';
import type { LookupOption } from '@/lib/lookup';
import {
  canLoadMore,
  initialState,
  needsFirstLoad,
  reduce,
  type AutocompleteEvent,
  type AutocompleteState,
} from './state';

const opt = (n: number): LookupOption => ({ id: `id-${n}`, label: `Option ${n}` });
const page = (from: number, count: number, more: boolean) => ({
  options: Array.from({ length: count }, (_, i) => opt(from + i)),
  nextCursor: more ? `cursor-${from + count}` : null,
});
let rid = 0;
const f = (append = false): AutocompleteEvent => ({ type: 'fetch', append, requestId: ++rid });
const t = (query: string): AutocompleteEvent => ({ type: 'type', query, requestId: ++rid });
const run = (events: AutocompleteEvent[], from: AutocompleteState = initialState) =>
  events.reduce(reduce, from);

describe('what loads, and when', () => {
  it('loads nothing until it is opened: a fresh state asks for a first load only when opened', () => {
    expect(initialState.options).toEqual([]);
    expect(initialState.loadedFor).toBeNull();
    expect(needsFirstLoad(initialState)).toBe(true);
    expect(initialState.open).toBe(false);
  });

  it('loads the first page once, and not again just because it is opened again', () => {
    let s = run([{ type: 'open' }, f()]);
    expect(s.phase).toBe('loading');
    expect(needsFirstLoad(s)).toBe(false);
    s = reduce(s, {
      type: 'loaded',
      requestId: s.requestId,
      page: page(0, 20, true),
      append: false,
      maxOptions: 100,
    });
    expect(s.options).toHaveLength(20);
    expect(s.loadedFor).toBe('');
    expect(needsFirstLoad(run([{ type: 'close' }, { type: 'open' }], s))).toBe(false);
  });

  it('typing starts a new search and asks for a new first load', () => {
    let s = run([{ type: 'open' }, f()]);
    s = reduce(s, {
      type: 'loaded',
      requestId: s.requestId,
      page: page(0, 5, false),
      append: false,
      maxOptions: 100,
    });
    s = reduce(s, t('ri'));
    expect(s.query).toBe('ri');
    expect(needsFirstLoad(s)).toBe(true);
    expect(s.nextCursor).toBeNull();
  });
});

describe('after a choice', () => {
  it('forgets what was loaded, so the next open loads afresh, and drops answers still in flight', () => {
    let s = run([{ type: 'open' }, f()]);
    const inFlight = s.requestId;
    s = reduce(s, { type: 'reset', requestId: ++rid });
    expect(s).toMatchObject({ open: false, options: [], loadedFor: null, query: '' });
    expect(needsFirstLoad(s)).toBe(true);
    const late = reduce(s, {
      type: 'loaded',
      requestId: inFlight,
      page: page(0, 3, false),
      append: false,
      maxOptions: 100,
    });
    expect(late.options).toEqual([]);
  });
});

describe('stale answers', () => {
  it('ignores a response for an older request', () => {
    let s = run([{ type: 'open' }, f()]);
    const old = s.requestId;
    s = run([t('a'), f()], s);
    const after = reduce(s, {
      type: 'loaded',
      requestId: old,
      page: page(0, 3, false),
      append: false,
      maxOptions: 100,
    });
    expect(after).toBe(s);
    expect(reduce(s, { type: 'failed', requestId: old, message: 'late' })).toBe(s);
  });

  it('ignores a response that arrives after the person has typed again', () => {
    let s = run([{ type: 'open' }, t('a'), f()]);
    const inFlight = s.requestId;
    s = reduce(s, t('ab'));
    const after = reduce(s, {
      type: 'loaded',
      requestId: inFlight,
      page: page(0, 3, false),
      append: false,
      maxOptions: 100,
    });
    expect(after.options).toEqual([]);
    expect(after.loadedFor).toBeNull();
  });
});

describe('growing the list', () => {
  const loaded = (): AutocompleteState => {
    const s = run([{ type: 'open' }, f()]);
    return reduce(s, {
      type: 'loaded',
      requestId: s.requestId,
      page: page(0, 20, true),
      append: false,
      maxOptions: 50,
    });
  };

  it('appends the next page and can load more only when idle with a cursor', () => {
    let s = loaded();
    expect(canLoadMore(s)).toBe(true);
    s = reduce(s, f(true));
    expect(canLoadMore(s)).toBe(false);
    expect(s.options).toHaveLength(20);
    s = reduce(s, {
      type: 'loaded',
      requestId: s.requestId,
      page: page(20, 20, false),
      append: true,
      maxOptions: 50,
    });
    expect(s.options.map((o) => o.id)).toEqual(Array.from({ length: 40 }, (_, i) => `id-${i}`));
    expect(canLoadMore(s)).toBe(false);
  });

  it('never holds more than the cap and tells the person to narrow the search', () => {
    let s = loaded();
    s = reduce(s, f(true));
    s = reduce(s, {
      type: 'loaded',
      requestId: s.requestId,
      page: page(20, 20, true),
      append: true,
      maxOptions: 30,
    });
    expect(s.options).toHaveLength(30);
    expect(s.capped).toBe(true);
    expect(canLoadMore(s)).toBe(false);
  });

  it('a cap that lands exactly on the last page is not "capped"', () => {
    const s = run([{ type: 'open' }, f()]);
    const done = reduce(s, {
      type: 'loaded',
      requestId: s.requestId,
      page: page(0, 30, false),
      append: false,
      maxOptions: 30,
    });
    expect(done.capped).toBe(false);
  });

  it('keeps what is on screen when a later page fails, and reports the error', () => {
    let s = loaded();
    s = reduce(s, f(true));
    s = reduce(s, { type: 'failed', requestId: s.requestId, message: 'Network down' });
    expect(s.phase).toBe('error');
    expect(s.error).toBe('Network down');
    expect(s.options).toHaveLength(20);
  });
});

describe('keyboard movement', () => {
  const withOptions = (n: number): AutocompleteState => {
    const s = run([{ type: 'open' }, f()]);
    return reduce(s, {
      type: 'loaded',
      requestId: s.requestId,
      page: page(0, n, false),
      append: false,
      maxOptions: 100,
    });
  };

  it('starts on the first option and wraps both ways', () => {
    let s = withOptions(3);
    expect(s.active).toBe(0);
    s = run(
      [
        { type: 'move', to: 'next' },
        { type: 'move', to: 'next' },
      ],
      s,
    );
    expect(s.active).toBe(2);
    expect(reduce(s, { type: 'move', to: 'next' }).active).toBe(0);
    expect(run([{ type: 'move', to: 'previous' }], withOptions(3)).active).toBe(2);
    expect(reduce(s, { type: 'move', to: 'first' }).active).toBe(0);
    expect(reduce(s, { type: 'move', to: 'last' }).active).toBe(2);
  });

  it('does nothing with no options and ignores hover past the ends', () => {
    expect(reduce(initialState, { type: 'move', to: 'next' })).toBe(initialState);
    const s = withOptions(2);
    expect(reduce(s, { type: 'hover', index: 5 })).toBe(s);
    expect(reduce(s, { type: 'hover', index: 1 }).active).toBe(1);
  });

  it('closing clears the highlight', () => {
    expect(reduce(withOptions(2), { type: 'close' })).toMatchObject({ open: false, active: -1 });
  });
});
