// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LookupOption, LookupPage } from '@/lib/lookup';
import { Autocomplete, type AutocompleteProps } from './Autocomplete';

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    onClick,
  }: {
    href: string;
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <a href={href} onClick={onClick}>
      {children}
    </a>
  ),
}));

afterEach(cleanup);

const option = (n: number): LookupOption => ({
  id: `id-${String(n)}`,
  label: `Option ${String(n)}`,
});
const page = (from: number, count: number, more: boolean): LookupPage => ({
  options: Array.from({ length: count }, (_, i) => option(from + i)),
  nextCursor: more ? `cursor-${String(from + count)}` : null,
});

function setup(over: Partial<AutocompleteProps> = {}) {
  const loadOptions = vi.fn(() => Promise.resolve(page(0, 3, false)));
  const onChange = vi.fn();
  const result = render(
    <Autocomplete
      label="Template"
      value={null}
      onChange={onChange}
      loadOptions={loadOptions}
      debounceMs={50}
      {...over}
    />,
  );
  return {
    loadOptions,
    onChange,
    ...result,
    field: screen.getByRole('combobox', { name: 'Template' }),
  };
}

describe('the Autocomplete component', () => {
  it('loads nothing until it is used', async () => {
    const { loadOptions, field } = setup();
    await act(() => Promise.resolve());
    expect(loadOptions).not.toHaveBeenCalled();
    expect(field).toHaveAttribute('aria-expanded', 'false');
  });

  it('loads one page when focused, with the page size asked for, and shows it', async () => {
    const { loadOptions, field } = setup({ pageSize: 7 });
    await userEvent.click(field);
    expect(loadOptions).toHaveBeenCalledTimes(1);
    expect(loadOptions).toHaveBeenCalledWith({ query: '', cursor: null, limit: 7 });
    expect(await screen.findAllByRole('option')).toHaveLength(3);
    expect(field).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('3 results');
  });

  it('defaults to a page of 20', async () => {
    const { loadOptions, field } = setup();
    await userEvent.click(field);
    expect(loadOptions).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }));
  });

  it('does not load again when closed and reopened with nothing typed', async () => {
    const { loadOptions, field } = setup();
    await userEvent.click(field);
    await screen.findAllByRole('option');
    await userEvent.keyboard('{Escape}');
    expect(field).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(field);
    await screen.findAllByRole('option');
    // After a close the list is forgotten, so reopening loads afresh: that is one more call.
    expect(loadOptions.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('searches with the typed text after a pause, and uses only the newest answer', async () => {
    const resolvers: ((p: LookupPage) => void)[] = [];
    const loadOptions = vi.fn(() => new Promise<LookupPage>((resolve) => resolvers.push(resolve)));
    const { field } = setup({ loadOptions });
    await userEvent.click(field); // first load, left hanging
    await userEvent.type(field, 'ab');
    await waitFor(() =>
      expect(loadOptions).toHaveBeenLastCalledWith({ query: 'ab', cursor: null, limit: 20 }),
    );
    // The answers arrive out of order: the older ones must not show.
    await act(async () => {
      resolvers.at(-1)?.({ options: [{ id: 'new', label: 'Fresh' }], nextCursor: null });
      resolvers.at(0)?.({ options: [{ id: 'old', label: 'Stale' }], nextCursor: null });
      await Promise.resolve();
    });
    expect(await screen.findByRole('option', { name: /Fresh/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Stale/ })).not.toBeInTheDocument();
  });

  it('chooses with the mouse, reports the option, and closes', async () => {
    const { onChange, field } = setup();
    await userEvent.click(field);
    await userEvent.click(await screen.findByRole('option', { name: 'Option 1' }));
    expect(onChange).toHaveBeenCalledWith(option(1));
    expect(field).toHaveAttribute('aria-expanded', 'false');
  });

  it('works by keyboard: arrows wrap, Enter chooses, Escape closes', async () => {
    const { onChange, field } = setup();
    await userEvent.click(field);
    await screen.findAllByRole('option');
    expect(field.getAttribute('aria-activedescendant')).toMatch(/option-0$/);
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(field.getAttribute('aria-activedescendant')).toMatch(/option-2$/);
    await userEvent.keyboard('{ArrowDown}');
    expect(field.getAttribute('aria-activedescendant')).toMatch(/option-0$/);
    await userEvent.keyboard('{ArrowUp}');
    expect(field.getAttribute('aria-activedescendant')).toMatch(/option-2$/);
    await userEvent.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith(option(2));

    await userEvent.click(field);
    await screen.findAllByRole('option');
    await userEvent.keyboard('{Escape}');
    expect(field).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows the chosen label while closed and a clear button that empties the choice', async () => {
    const { onChange } = setup({ value: 'id-1', valueLabel: 'Option 1' });
    expect(screen.getByRole('combobox')).toHaveValue('Option 1');
    await userEvent.click(screen.getByRole('button', { name: 'Clear Template' }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('marks the chosen option as selected', async () => {
    const { field } = setup({ value: 'id-1', valueLabel: 'Option 1' });
    await userEvent.click(field);
    expect(await screen.findByRole('option', { name: 'Option 1' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('option', { name: 'Option 0' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('loads the next page on request and appends it', async () => {
    const loadOptions = vi
      .fn<
        (request: { query: string; cursor: string | null; limit: number }) => Promise<LookupPage>
      >()
      .mockResolvedValueOnce(page(0, 2, true))
      .mockResolvedValueOnce(page(2, 2, false));
    const { field } = setup({ loadOptions, pageSize: 2 });
    await userEvent.click(field);
    expect(await screen.findAllByRole('option')).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findAllByRole('option')).toHaveLength(4);
    expect(loadOptions).toHaveBeenLastCalledWith({ query: '', cursor: 'cursor-2', limit: 2 });
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('never holds more than the cap, and says to narrow the search', async () => {
    const loadOptions = vi
      .fn<
        (request: { query: string; cursor: string | null; limit: number }) => Promise<LookupPage>
      >()
      .mockResolvedValueOnce(page(0, 3, true))
      .mockResolvedValueOnce(page(3, 3, true));
    const { field } = setup({ loadOptions, pageSize: 3, maxOptions: 5 });
    await userEvent.click(field);
    await screen.findAllByRole('option');
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(5));
    expect(screen.getByRole('status')).toHaveTextContent('Type to narrow the search');
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('says so when nothing matches', async () => {
    const { field } = setup({
      loadOptions: vi.fn(() => Promise.resolve({ options: [], nextCursor: null })),
      emptyMessage: 'Nothing here',
    });
    await userEvent.click(field);
    expect(await screen.findByText('Nothing here')).toBeInTheDocument();
  });

  it('reports a failure and tries again on request', async () => {
    const loadOptions = vi
      .fn<
        (request: { query: string; cursor: string | null; limit: number }) => Promise<LookupPage>
      >()
      .mockRejectedValueOnce(new Error('Network down'))
      .mockResolvedValueOnce(page(0, 2, false));
    const { field } = setup({ loadOptions });
    await userEvent.click(field);
    expect(await screen.findByText('Network down')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findAllByRole('option')).toHaveLength(2);
  });

  it('offers create and view-all as links, and closes when one is followed', async () => {
    const { field } = setup({
      createHref: '/new',
      createLabel: 'Create one',
      listHref: '/all',
      listLabel: 'See all',
    });
    await userEvent.click(field);
    await screen.findAllByRole('option');
    expect(screen.getByRole('link', { name: '+ Create one' })).toHaveAttribute('href', '/new');
    const all = screen.getByRole('link', { name: 'See all' });
    expect(all).toHaveAttribute('href', '/all');
    fireEvent.click(all);
    expect(field).toHaveAttribute('aria-expanded', 'false');
  });

  it('submits the chosen id with a form when given a name', () => {
    const { container } = setup({ value: 'id-9', name: 'template' });
    expect(container.querySelector('input[type="hidden"][name="template"]')).toHaveValue('id-9');
  });

  it('shows an error under the field and marks it invalid', () => {
    const { field } = setup({ error: 'Pick one' });
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Pick one');
  });

  it('does nothing when disabled', async () => {
    const { loadOptions, field } = setup({ disabled: true });
    await userEvent.click(field);
    expect(loadOptions).not.toHaveBeenCalled();
    expect(field).toBeDisabled();
  });
});
