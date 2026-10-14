// @vitest-environment jsdom
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { QuoteListPage, QuoteListRow } from '@/server/domains/quotes/service';
import type { QuoteActionResult } from '@/server/domains/quotes/action-result';
import { QuotesTable, type QuoteRowHandlers } from './QuotesTable';

const replace = vi.fn();
const listPage = vi.fn();

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));
vi.mock('@/server/domains/quotes/actions', () => ({
  listSalesQuotesPageAction: (...args: unknown[]) => listPage(...args) as unknown,
}));
vi.mock('@/components/ui/autocomplete/LookupAutocomplete', () => ({
  LookupAutocomplete: ({
    onChange,
    valueLabel,
  }: {
    onChange: (o: { id: string; label: string }) => void;
    valueLabel: string;
  }) => (
    <button type="button" onClick={() => onChange({ id: 'cancelled', label: 'cancelled' })}>
      status:{valueLabel}
    </button>
  ),
}));

beforeEach(() => {
  replace.mockClear();
  listPage.mockReset();
});
afterEach(cleanup);

const row = (n: number, over: Partial<QuoteListRow> = {}): QuoteListRow =>
  ({
    id: `q${String(n)}`,
    quoteNumber: `QTE-${String(n)}`,
    customerName: `Customer ${String(n)}`,
    customerEmail: `c${String(n)}@x.test`,
    customerReference: null,
    status: 'draft',
    approvalStatus: 'not_required',
    approvalManagedBy: null,
    currency: 'KES',
    totalAmount: '1000',
    grossProfit: '300',
    grossMarginPercent: '30',
    minimumMarginPercent: '10',
    validUntil: null,
    createdAt: new Date('2026-10-01'),
    expired: false,
    ...over,
  }) as unknown as QuoteListRow;

const ready = (
  rows: QuoteListRow[],
  nextCursor: string | null = null,
): Promise<QuoteActionResult<QuoteListPage>> =>
  Promise.resolve({ ok: true, data: { rows, nextCursor } });

const handlers = (): QuoteRowHandlers => ({
  view: vi.fn(),
  edit: vi.fn(),
  template: vi.fn(),
  download: vi.fn(),
  approve: vi.fn(),
  email: vi.fn(),
  convert: vi.fn(),
});
const all = { canCreate: true, canUpdate: true, canApprove: true };

async function show(
  firstPage: Promise<QuoteActionResult<QuoteListPage>>,
  over: {
    query?: string;
    status?: 'all' | 'cancelled';
    permissions?: typeof all;
    h?: QuoteRowHandlers;
  } = {},
) {
  const h = over.h ?? handlers();
  await act(async () => {
    render(
      <Suspense fallback={<p>fallback</p>}>
        <QuotesTable
          firstPage={firstPage}
          query={over.query ?? ''}
          status={over.status ?? 'all'}
          permissions={over.permissions ?? all}
          busyId={null}
          handlers={h}
        />
      </Suspense>,
    );
    await firstPage;
  });
  return h;
}

describe('the quotes table', () => {
  it('shows the rows of the first page with their figures and status', async () => {
    await show(ready([row(1), row(2, { status: 'accepted' })]));
    const table = screen.getByRole('table');
    expect(within(table).getByText('QTE-1')).toBeInTheDocument();
    expect(within(table).getByText('Customer 2')).toBeInTheDocument();
    expect(within(table).getAllByText(/KES 1,000\.00/)).toHaveLength(2);
    expect(within(table).getAllByText('30.0%')).toHaveLength(2);
    expect(within(table).getByText('accepted')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('2 quotes shown');
  });

  it('shows expired in place of the status for an expired quote', async () => {
    await show(ready([row(1, { status: 'sent', expired: true })]));
    expect(screen.getByText('expired')).toBeInTheDocument();
  });

  it('flags an open quote that has no customer email', async () => {
    await show(ready([row(1, { customerEmail: null })]));
    expect(screen.getByText(/No email: edit the quote to add one/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cannot email QTE-1/ })).toBeDisabled();
  });

  it('offers only the actions the person may take on that quote', async () => {
    await show(ready([row(1)]), {
      permissions: { canCreate: false, canUpdate: false, canApprove: false },
    });
    expect(screen.getByRole('button', { name: 'View QTE-1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download PDF of QTE-1/ })).toBeInTheDocument();
    for (const name of [
      /Edit QTE-1/,
      /Email QTE-1/,
      /Approve QTE-1/,
      /template from QTE-1/,
      /Convert QTE-1/,
    ]) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
  });

  it('calls the handler for the row that was acted on', async () => {
    const h = handlers();
    await show(
      ready([row(1), row(2, { status: 'accepted' }), row(3, { status: 'pending_approval' })]),
      { h },
    );
    await userEvent.click(screen.getByRole('button', { name: 'View QTE-1' }));
    expect(h.view).toHaveBeenCalledWith(expect.objectContaining({ id: 'q1' }));
    await userEvent.click(screen.getByRole('button', { name: 'Edit QTE-1' }));
    expect(h.edit).toHaveBeenCalledWith(expect.objectContaining({ id: 'q1' }));
    await userEvent.click(screen.getByRole('button', { name: 'Email QTE-1' }));
    expect(h.email).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: /Convert QTE-2/ }));
    expect(h.convert).toHaveBeenCalledWith(expect.objectContaining({ id: 'q2' }));
    await userEvent.click(screen.getByRole('button', { name: 'Approve QTE-3' }));
    expect(h.approve).toHaveBeenCalledWith(expect.objectContaining({ id: 'q3' }));
    await userEvent.click(screen.getAllByRole('button', { name: /Download PDF/ })[0]);
    expect(h.download).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /template from QTE-1/ }));
    expect(h.template).toHaveBeenCalled();
  });

  it('says there are no quotes, and that nothing matches when filtered', async () => {
    await show(ready([]));
    expect(screen.getByText(/No quotes yet/)).toBeInTheDocument();
    cleanup();
    await show(ready([]), { query: 'zzz' });
    expect(screen.getByText('No quotes match those filters.')).toBeInTheDocument();
  });

  it('shows the server’s message when the page could not be read', async () => {
    await show(Promise.resolve({ ok: false, error: 'You do not have permission to do that.' }));
    expect(screen.getByRole('alert')).toHaveTextContent('You do not have permission to do that.');
  });

  it('loads the next page with the same search and status, and adds it below', async () => {
    listPage.mockResolvedValue({ ok: true, data: { rows: [row(3)], nextCursor: null } });
    await show(ready([row(1), row(2)], 'cursor-2'), { query: 'abc', status: 'cancelled' });
    expect(screen.getByRole('status')).toHaveTextContent('more available');
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(listPage).toHaveBeenCalledWith({
      query: 'abc',
      status: 'cancelled',
      cursor: 'cursor-2',
    });
    expect(await screen.findByText('QTE-3')).toBeInTheDocument();
    expect(screen.getByText('QTE-1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('keeps what is shown and says why when a later page fails', async () => {
    listPage.mockResolvedValue({ ok: false, error: 'Could not load the list.' });
    await show(ready([row(1)], 'c'));
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Could not load the list.')).toBeInTheDocument();
    expect(screen.getByText('QTE-1')).toBeInTheDocument();
  });

  it('puts a search in the address after a pause in typing, not at every key', async () => {
    vi.useFakeTimers();
    try {
      await show(ready([row(1)]));
      const box = screen.getByRole('searchbox', { name: 'Search quotes' });
      fireEvent.change(box, { target: { value: 'ab' } });
      fireEvent.change(box, { target: { value: 'abc' } });
      expect(replace).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(350);
      });
      expect(replace).toHaveBeenCalledTimes(1);
      expect(replace).toHaveBeenCalledWith('/admin/quotes?q=abc');
    } finally {
      vi.useRealTimers();
    }
  });

  it('puts a chosen status in the address, keeping the search', async () => {
    await show(ready([row(1)]), { query: 'abc' });
    await userEvent.click(screen.getByRole('button', { name: /status:/ }));
    expect(replace).toHaveBeenCalledWith('/admin/quotes?q=abc&status=cancelled');
  });
});
