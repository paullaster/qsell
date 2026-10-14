// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { usePagedList, type PageResult } from './usePagedList';

afterEach(cleanup);

interface Row {
  id: number;
}
const rows = (from: number, n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: from + i }));
const ok = (r: Row[], next: string | null): PageResult<Row> => ({
  ok: true,
  data: { rows: r, nextCursor: next },
});

function Harness({
  load,
  initialPage,
}: {
  load: (f: { q: string }, cursor: string | null) => Promise<PageResult<Row>>;
  initialPage?: PageResult<Row>;
}) {
  const [q, setQ] = useState('');
  const list = usePagedList<Row, { q: string }>({ load, filters: { q }, initialPage });
  return (
    <div>
      <button onClick={() => setQ('x')}>filter</button>
      <button onClick={list.loadMore}>more</button>
      <button onClick={list.retry}>retry</button>
      <button onClick={list.reload}>reload</button>
      <p data-testid="state">{`${list.phase}|${list.rows.map((r) => r.id).join(',')}|${list.cursor ?? 'end'}|${list.error ?? ''}`}</p>
    </div>
  );
}
const state = () => screen.getByTestId('state').textContent;

describe('usePagedList', () => {
  it('reads the first page when it opens', async () => {
    const load = vi.fn(() => Promise.resolve(ok(rows(0, 2), 'c1')));
    render(<Harness load={load} />);
    expect(state()).toMatch(/^loading/);
    await waitFor(() => expect(state()).toBe('idle|0,1|c1|'));
    expect(load).toHaveBeenCalledWith({ q: '' }, null);
  });

  it('shows a page the server already sent, without fetching it again', async () => {
    const load = vi.fn(() => Promise.resolve(ok(rows(9, 1), null)));
    render(<Harness load={load} initialPage={ok(rows(0, 3), 'c1')} />);
    expect(state()).toBe('idle|0,1,2|c1|');
    await act(() => Promise.resolve());
    expect(load).not.toHaveBeenCalled();
  });

  it('reads again when the filters change, and appends on loadMore', async () => {
    const load = vi
      .fn<(f: { q: string }, cursor: string | null) => Promise<PageResult<Row>>>()
      .mockResolvedValueOnce(ok(rows(0, 2), 'c1'))
      .mockResolvedValueOnce(ok(rows(2, 1), null))
      .mockResolvedValueOnce(ok(rows(7, 1), null));
    render(<Harness load={load} />);
    await waitFor(() => expect(state()).toBe('idle|0,1|c1|'));
    await userEvent.click(screen.getByText('more'));
    await waitFor(() => expect(state()).toBe('idle|0,1,2|end|'));
    await userEvent.click(screen.getByText('filter'));
    await waitFor(() => expect(state()).toBe('idle|7|end|'));
    expect(load).toHaveBeenLastCalledWith({ q: 'x' }, null);
  });

  it('reports a failure, keeps the rows, and retries the same page', async () => {
    const load = vi
      .fn<(f: { q: string }, cursor: string | null) => Promise<PageResult<Row>>>()
      .mockResolvedValueOnce(ok(rows(0, 1), 'c1'))
      .mockResolvedValueOnce({ ok: false, error: 'Boom' })
      .mockResolvedValueOnce(ok(rows(1, 1), null));
    render(<Harness load={load} />);
    await waitFor(() => expect(state()).toBe('idle|0|c1|'));
    await userEvent.click(screen.getByText('more'));
    await waitFor(() => expect(state()).toBe('error|0|c1|Boom'));
    await userEvent.click(screen.getByText('retry'));
    await waitFor(() => expect(state()).toBe('idle|0,1|end|'));
  });

  it('turns a thrown error into a message', async () => {
    const load = vi.fn(() => Promise.reject(new Error('Offline')));
    render(<Harness load={load} />);
    await waitFor(() => expect(state()).toBe('error||end|Offline'));
  });

  it('does not ask for more while a page is loading or when there is no more', async () => {
    let finish: (r: PageResult<Row>) => void = () => undefined;
    const load = vi
      .fn<(f: { q: string }, cursor: string | null) => Promise<PageResult<Row>>>()
      .mockResolvedValueOnce(ok(rows(0, 1), 'c1'))
      .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    render(<Harness load={load} />);
    await waitFor(() => expect(state()).toBe('idle|0|c1|'));
    await userEvent.click(screen.getByText('more'));
    await userEvent.click(screen.getByText('more'));
    expect(load).toHaveBeenCalledTimes(2);
    await act(async () => {
      finish(ok(rows(1, 1), null));
      await Promise.resolve();
    });
    await waitFor(() => expect(state()).toBe('idle|0,1|end|'));
    await userEvent.click(screen.getByText('more'));
    expect(load).toHaveBeenCalledTimes(2);
  });
});
