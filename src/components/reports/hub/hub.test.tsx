// @vitest-environment jsdom
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ListReportsResult } from '@/server/domains/reports/actions';
import { FilterBar, type FilterState } from '../kit/FilterBar';
import { ReportsHub } from './ReportsHub';

const push = vi.fn();
let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/admin',
  useSearchParams: () => new URLSearchParams(search),
}));
vi.mock('@/components/ui/autocomplete/ChoicePicker', () => ({
  ChoicePicker: ({ label, choice }: { label: string; choice: { label: string } | null }) => (
    <div data-testid="branch-picker">
      {label}: {choice?.label ?? 'All branches'}
    </div>
  ),
}));
// A server action is called when more audit rows are asked for; the hub does not need it.
vi.mock('@/server/domains/reports/actions', () => ({
  listReportAuditAction: vi.fn(),
  listReportsAction: vi.fn(),
}));

beforeEach(() => {
  push.mockClear();
  search = '';
  window.localStorage.clear();
});
afterEach(cleanup);

const items: Extract<ListReportsResult, { ok: true }>['data'] = [
  {
    code: 'receivables-ageing',
    title: 'Receivables ageing',
    question: 'Who owes us money?',
    family: 'finance',
    familyLabel: 'Finance',
    href: '/admin/reports/receivables-ageing',
    keywords: ['debtors'],
    downloadable: true,
  },
  {
    code: 'trial-balance',
    title: 'Trial balance',
    question: 'Do the books balance?',
    family: 'finance',
    familyLabel: 'Finance',
    href: '/admin/reports/trial-balance',
    keywords: [],
    downloadable: false,
  },
  {
    code: 'late-deliveries',
    title: 'Late deliveries',
    question: 'Which are late?',
    family: 'delivery',
    familyLabel: 'Delivery and logistics',
    href: '/admin/reports/late-deliveries',
    keywords: [],
    downloadable: false,
  },
];

async function renderHub(result: ListReportsResult) {
  await act(async () => {
    await Promise.resolve();
    render(
      <Suspense fallback={<p>loading</p>}>
        <ReportsHub listPromise={Promise.resolve(result)} />
      </Suspense>,
    );
  });
}

describe('ReportsHub', () => {
  it('draws the heading at once and groups reports by what they tell you', async () => {
    await renderHub({ ok: true, data: items });
    expect(screen.getByRole('heading', { level: 2, name: 'Reports' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Finance' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 3, name: 'Delivery and logistics' }),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId('report-card')).toHaveLength(3);
    expect(screen.getByText('Who owes us money?')).toBeInTheDocument();
  });

  it('filters the list as you type', async () => {
    await renderHub({ ok: true, data: items });
    await userEvent.type(screen.getByRole('searchbox', { name: 'Filter this list' }), 'late');
    expect(screen.getAllByTestId('report-card')).toHaveLength(1);
    expect(screen.queryByRole('heading', { level: 3, name: 'Finance' })).toBeNull();
  });

  it('says so when nothing matches', async () => {
    await renderHub({ ok: true, data: items });
    await userEvent.type(screen.getByRole('searchbox', { name: 'Filter this list' }), 'zzzz');
    expect(screen.getByText(/No report matches/)).toBeInTheDocument();
  });

  it('stars a report, keeps it first and remembers it in this browser', async () => {
    await renderHub({ ok: true, data: items });
    await userEvent.click(screen.getByRole('button', { name: 'Star Late deliveries' }));
    expect(screen.getByRole('heading', { level: 3, name: 'Starred' })).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem('qsell_report_favourites_v1') ?? '[]')).toEqual([
      'late-deliveries',
    ]);
    const starred = screen.getByRole('heading', { level: 3, name: 'Starred' }).closest('section');
    expect(within(must(starred)).getByText('Late deliveries')).toBeInTheDocument();
    // The card shows in the Starred group and again under its own family; both carry the same toggle.
    const [firstToggle] = screen.getAllByRole('button', {
      name: 'Remove Late deliveries from starred',
    });
    await userEvent.click(must(firstToggle));
    expect(screen.queryByRole('heading', { level: 3, name: 'Starred' })).toBeNull();
  });

  it('survives a broken saved list', async () => {
    window.localStorage.setItem('qsell_report_favourites_v1', '{not json');
    await renderHub({ ok: true, data: items });
    expect(screen.queryByRole('heading', { level: 3, name: 'Starred' })).toBeNull();
    window.localStorage.setItem(
      'qsell_report_favourites_v1',
      JSON.stringify([5, null, 'trial-balance']),
    );
    cleanup();
    await renderHub({ ok: true, data: items });
    expect(screen.getByRole('heading', { level: 3, name: 'Starred' })).toBeInTheDocument();
  });

  it('narrows to one module when the menu opens it, and offers the way back to all', async () => {
    search = 'module=delivery';
    await renderHub({ ok: true, data: items });
    expect(screen.getAllByTestId('report-card')).toHaveLength(1);
    expect(screen.getByText('Late deliveries')).toBeInTheDocument();
    expect(screen.queryByText('Trial balance')).toBeNull();
    expect(screen.getByRole('link', { name: 'All reports' })).toHaveAttribute(
      'href',
      '/admin/reports',
    );
  });

  it('offers the page with downloads only for a report that can be downloaded', async () => {
    await renderHub({ ok: true, data: items });
    expect(
      screen.getByRole('link', { name: 'Open Receivables ageing with downloads' }),
    ).toHaveAttribute('href', '/admin/reports/receivables-ageing');
    expect(screen.queryByRole('link', { name: /Open Trial balance with downloads/ })).toBeNull();
  });

  it('says what to do when the person may open no report, and when the list could not load', async () => {
    await renderHub({ ok: true, data: [] });
    expect(screen.getByText(/No reports are open to you yet/)).toBeInTheDocument();
    cleanup();
    await renderHub({ ok: false, error: 'nope' });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The list of reports could not be loaded just now.',
    );
  });
});

describe('FilterBar', () => {
  const filters: FilterState = {
    preset: 'this_month',
    compare: 'previous_period',
    branch: null,
    fromDate: '2026-03-01',
    toDate: '2026-03-10',
    rangeLabel: '1 Mar 2026 – 10 Mar 2026',
    compareRangeLabel: '19 Feb 2026 – 28 Feb 2026',
    scopeLabel: 'All branches',
    updatedLabel: '10 Mar, 18:00',
    presets: [
      { value: 'today', label: 'Today' },
      { value: 'this_month', label: 'This month' },
    ],
    compareModes: [
      { value: 'previous_period', label: 'Previous period' },
      { value: 'previous_year', label: 'Same period last year' },
    ],
    canPickBranch: true,
  };

  it('states the period, the comparison and when the figures were made', () => {
    render(<FilterBar filters={filters}>figures</FilterBar>);
    expect(screen.getByText('1 Mar 2026 – 10 Mar 2026')).toBeInTheDocument();
    expect(screen.getByText('19 Feb 2026 – 28 Feb 2026')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Updated 10 Mar, 18:00');
    expect(screen.getByRole('button', { name: 'This month' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('writes a preset to the address', async () => {
    render(<FilterBar filters={filters}>figures</FilterBar>);
    await userEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(push).toHaveBeenCalledWith('/admin?period=today', { scroll: false });
  });

  it('writes the comparison to the address and keeps the other choices', async () => {
    search = 'period=this_month&branch=b1';
    render(<FilterBar filters={filters}>figures</FilterBar>);
    await userEvent.click(screen.getByRole('radio', { name: 'Same period last year' }));
    expect(push).toHaveBeenCalledWith('/admin?period=this_month&branch=b1&compare=previous_year', {
      scroll: false,
    });
  });

  it('writes a typed date range as a custom period, and refuses an upside-down one', () => {
    render(<FilterBar filters={filters}>figures</FilterBar>);
    const from = screen.getByLabelText('From');
    fireEvent_change(from, '2026-03-05');
    expect(push).toHaveBeenCalledWith('/admin?period=custom&from=2026-03-05&to=2026-03-10', {
      scroll: false,
    });
    push.mockClear();
    fireEvent_change(from, '2026-03-20');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The start date must be on or before the end date.',
    );
    expect(push).not.toHaveBeenCalled();
  });

  it('offers the branch search only to someone who may choose a branch, never as a native select', () => {
    const { container, rerender } = render(<FilterBar filters={filters}>figures</FilterBar>);
    expect(screen.getByTestId('branch-picker')).toHaveTextContent('Branch: All branches');
    expect(container.querySelector('select')).toBeNull();
    rerender(<FilterBar filters={{ ...filters, canPickBranch: false }}>figures</FilterBar>);
    expect(screen.queryByTestId('branch-picker')).toBeNull();
    rerender(
      <FilterBar filters={{ ...filters, branch: { id: 'b1', name: 'Mombasa' } }}>
        figures
      </FilterBar>,
    );
    expect(screen.getByTestId('branch-picker')).toHaveTextContent('Branch: Mombasa');
  });
});

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a value');
  return value;
}

function fireEvent_change(input: HTMLElement, value: string): void {
  fireEvent.change(input, { target: { value } });
}
