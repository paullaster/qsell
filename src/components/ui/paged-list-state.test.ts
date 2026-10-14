import { describe, expect, it } from 'vitest';
import {
  initialPagedState,
  reducePaged,
  type PagedEvent,
  type PagedState,
} from './paged-list-state';

interface Row { id: number }
const rows = (from: number, n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: from + i }));
const run = (events: PagedEvent<Row>[], from: PagedState<Row> = initialPagedState<Row>()) =>
  events.reduce(reducePaged, from);

describe('a list read a page at a time', () => {
  it('starts loading with nothing shown', () => {
    expect(initialPagedState()).toMatchObject({ rows: [], phase: 'loading', cursor: null });
  });

  it('shows the first page, then appends the next', () => {
    let s = run([
      { type: 'start', append: false, requestId: 1 },
      { type: 'loaded', requestId: 1, rows: rows(0, 3), cursor: 'c1', append: false },
    ]);
    expect(s).toMatchObject({ phase: 'idle', cursor: 'c1' });
    expect(s.rows).toHaveLength(3);
    s = run(
      [
        { type: 'start', append: true, requestId: 2 },
        { type: 'loaded', requestId: 2, rows: rows(3, 2), cursor: null, append: true },
      ],
      s,
    );
    expect(s.rows.map((r) => r.id)).toEqual([0, 1, 2, 3, 4]);
    expect(s.cursor).toBeNull();
  });

  it('a new first page keeps the old rows until it arrives, then replaces them', () => {
    const shown = run([
      { type: 'start', append: false, requestId: 1 },
      { type: 'loaded', requestId: 1, rows: rows(0, 3), cursor: 'c', append: false },
    ]);
    const again = run([{ type: 'start', append: false, requestId: 2 }], shown);
    expect(again.phase).toBe('loading');
    expect(again.rows).toHaveLength(3);
    const done = run(
      [{ type: 'loaded', requestId: 2, rows: rows(10, 1), cursor: null, append: false }],
      again,
    );
    expect(done.rows).toEqual([{ id: 10 }]);
  });

  it('ignores an answer for an older request', () => {
    const s = run([
      { type: 'start', append: false, requestId: 1 },
      { type: 'start', append: false, requestId: 2 },
    ]);
    expect(
      reducePaged(s, {
        type: 'loaded',
        requestId: 1,
        rows: rows(0, 2),
        cursor: null,
        append: false,
      }),
    ).toBe(s);
    expect(reducePaged(s, { type: 'failed', requestId: 1, message: 'late' })).toBe(s);
  });

  it('keeps what is shown when a later page fails, and reports it', () => {
    const shown = run([
      { type: 'start', append: false, requestId: 1 },
      { type: 'loaded', requestId: 1, rows: rows(0, 2), cursor: 'c', append: false },
      { type: 'start', append: true, requestId: 2 },
      { type: 'failed', requestId: 2, message: 'Network down' },
    ]);
    expect(shown).toMatchObject({ phase: 'error', error: 'Network down', cursor: 'c' });
    expect(shown.rows).toHaveLength(2);
    // Trying again clears the error.
    expect(run([{ type: 'start', append: true, requestId: 3 }], shown)).toMatchObject({
      phase: 'more',
      error: null,
    });
  });
});
