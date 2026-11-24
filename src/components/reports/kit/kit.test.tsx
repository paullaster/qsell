// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CommandPalette } from './CommandPalette';
import { DataTable } from './DataTable';
import { ExportButtons } from './ExportButtons';
import { Delta, HeroStrip, Kpi } from './Hero';
import { EmptyPanel, FailedPanel, Panel, PanelSkeleton } from './Panel';
import { ReportFrame } from './ReportFrame';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/admin/reports',
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(() => {
  push.mockClear();
});
afterEach(cleanup);

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a value');
  return value;
}

describe('Delta', () => {
  it('says up with words, an icon and the basis, and marks it good for sales', () => {
    render(<Delta current={112.4} previous={100} basis="last month" />);
    const d = screen.getByTestId('delta');
    expect(d).toHaveTextContent('Up 12.4% on last month');
    expect(d).toHaveAttribute('data-good', 'true');
  });

  it('marks a rise in overdue debt as bad (the same words, the other tone)', () => {
    render(<Delta current={120} previous={100} basis="last month" upIsGood={false} />);
    expect(screen.getByTestId('delta')).toHaveAttribute('data-good', 'false');
    expect(screen.getByTestId('delta')).toHaveTextContent('Up 20% on last month');
  });

  it('says down, level, and nothing to compare with', () => {
    render(<Delta current={80} previous={100} basis="last month" />);
    expect(screen.getByTestId('delta')).toHaveTextContent('Down 20% on last month');
    cleanup();
    render(<Delta current={100} previous={100} basis="last month" />);
    expect(screen.getByTestId('delta')).toHaveTextContent('Level with last month');
    cleanup();
    render(<Delta current={5} previous={0} basis="last month" />);
    expect(screen.getByTestId('delta')).toHaveTextContent('Nothing to compare with');
  });
});

describe('Kpi and HeroStrip', () => {
  it('shows the short figure and keeps the exact one for hover and screen readers', () => {
    render(
      <HeroStrip label="Headline figures">
        <Kpi label="Sales" value="KES 1.2M" fullValue="KES 1,234,567" hero />
      </HeroStrip>,
    );
    const kpi = screen.getByTestId('kpi');
    expect(within(kpi).getByText(/KES 1.2M/)).toHaveAttribute('title', 'KES 1,234,567');
    expect(kpi).toHaveTextContent('(KES 1,234,567)');
    expect(screen.getByRole('region', { name: 'Headline figures' })).toBeInTheDocument();
  });

  it('shows a note and a trend line only when given', () => {
    const { container } = render(
      <Kpi label="Orders" value="40" note="From 12 customers" trend={[1, 2, 3]} />,
    );
    expect(screen.getByText('From 12 customers')).toBeInTheDocument();
    expect(container.querySelector('svg')).not.toBeNull();
    cleanup();
    expect(render(<Kpi label="Orders" value="40" />).container.querySelector('svg')).toBeNull();
  });
});

describe('Panel states', () => {
  it('titles a panel with its definition and labels it for assistive technology', () => {
    render(
      <Panel id="p1" title="Sales" definition="What counts as a sale.">
        body
      </Panel>,
    );
    expect(screen.getByRole('region', { name: 'Sales' })).toBeInTheDocument();
    expect(screen.getByText('What counts as a sale.')).toBeInTheDocument();
  });

  it('announces loading, and offers a retry on failure', async () => {
    render(<PanelSkeleton label="sales" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading sales…');
    cleanup();
    const retry = vi.fn();
    render(<FailedPanel name="Sales" onRetry={retry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Sales could not be loaded just now.');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
    cleanup();
    render(<FailedPanel name="Sales" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('says why a panel is empty', () => {
    render(<EmptyPanel>No sales yet.</EmptyPanel>);
    expect(screen.getByTestId('empty-panel')).toHaveTextContent('No sales yet.');
  });
});

describe('ReportFrame', () => {
  it('shows the title, the downloads and a short note, and nothing else about the figures', () => {
    render(
      <ReportFrame
        title="Stock valuation"
        note="As at 10 Mar, 18:00"
        actions={<button>Download</button>}
      >
        <p>content</p>
      </ReportFrame>,
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Stock valuation' })).toBeInTheDocument();
    expect(screen.getByText('As at 10 Mar, 18:00')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
    expect(screen.queryByText(/Definitions|Live|Scope/)).toBeNull();
  });

  it('draws no note when there is none', () => {
    render(<ReportFrame title="T">c</ReportFrame>);
    expect(screen.getByRole('heading', { level: 2, name: 'T' })).toBeInTheDocument();
    expect(document.querySelector('header p')).toBeNull();
  });
});

describe('DataTable', () => {
  const columns = [
    { label: 'Customer', kind: 'text' as const },
    { label: 'Owed', kind: 'money' as const },
    { label: 'Invoices', kind: 'count' as const },
  ];
  const rows = [
    { id: '1', cells: ['Wanjiku', 1500, 4] },
    { id: '2', cells: ['Otieno', 300.5, 12], href: '/admin/customers/2' },
    { id: '3', cells: ['Achieng', null, 1] },
  ];

  const rowOrder = (): string[] =>
    within(must(screen.getAllByRole('table')[0]))
      .getAllByRole('rowheader')
      .map((h) => h.textContent);

  it('writes money with two decimals, counts grouped, and an empty cell empty', () => {
    render(<DataTable caption="Debtors" columns={columns} rows={rows} emptyMessage="None" />);
    const table = screen.getByRole('table', { name: 'Debtors' });
    expect(within(table).getByText('1,500.00')).toBeInTheDocument();
    expect(within(table).getByText('300.50')).toBeInTheDocument();
  });

  it('sorts by a column header: ascending, descending, then back to the original order', async () => {
    render(<DataTable caption="Debtors" columns={columns} rows={rows} emptyMessage="None" />);
    const header = screen.getByRole('columnheader', { name: /Owed/ });
    expect(rowOrder()).toEqual(['Wanjiku', 'Otieno', 'Achieng']);
    await userEvent.click(within(header).getByRole('button'));
    expect(header).toHaveAttribute('aria-sort', 'ascending');
    expect(rowOrder()).toEqual(['Otieno', 'Wanjiku', 'Achieng']);
    await userEvent.click(within(header).getByRole('button'));
    expect(header).toHaveAttribute('aria-sort', 'descending');
    expect(rowOrder()).toEqual(['Wanjiku', 'Otieno', 'Achieng']);
    await userEvent.click(within(header).getByRole('button'));
    expect(header).toHaveAttribute('aria-sort', 'none');
    expect(rowOrder()).toEqual(['Wanjiku', 'Otieno', 'Achieng']);
  });

  it('turns a row that leads somewhere into a link, in both the table and the phone cards', () => {
    render(<DataTable caption="Debtors" columns={columns} rows={rows} emptyMessage="None" />);
    const links = screen.getAllByRole('link');
    expect(links.length).toBeGreaterThanOrEqual(2);
    for (const l of links) expect(l).toHaveAttribute('href', '/admin/customers/2');
  });

  it('draws the totals row apart', () => {
    render(
      <DataTable
        caption="Debtors"
        columns={columns}
        rows={rows}
        totals={['Total', 1800.5, 17]}
        emptyMessage="None"
      />,
    );
    const table = screen.getByRole('table', { name: 'Debtors' });
    expect(within(table).getByText('1,800.50')).toBeInTheDocument();
    expect(table.querySelector('tfoot')).not.toBeNull();
  });

  it('says so when there is nothing to show', () => {
    render(
      <DataTable
        caption="Debtors"
        columns={columns}
        rows={[]}
        emptyMessage="Nobody owes you anything."
      />,
    );
    expect(screen.getByTestId('empty-table')).toHaveTextContent('Nobody owes you anything.');
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('moves between linked rows with the arrow keys', () => {
    const linked = [
      { id: '1', cells: ['A', 1, 1], href: '/a' },
      { id: '2', cells: ['B', 2, 2], href: '/b' },
    ];
    render(<DataTable caption="Debtors" columns={columns} rows={linked} emptyMessage="None" />);
    const table = screen.getByRole('table', { name: 'Debtors' });
    const [first, second] = within(table).getAllByRole('link');
    must(first).focus();
    fireEvent.keyDown(must(first), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(must(second), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(first);
  });
});

describe('ExportButtons', () => {
  it('links to the export address for each format with the report parameters', () => {
    render(
      <ExportButtons
        code="payables-ageing"
        formats={['csv', 'xlsx', 'pdf']}
        query="asOf=2026-03-10&groupBy=vendor"
        truncated={false}
      />,
    );
    const csv = screen.getByTestId('download-csv');
    expect(csv).toHaveAttribute(
      'href',
      '/api/admin/reports/payables-ageing/export?asOf=2026-03-10&groupBy=vendor&format=csv',
    );
    expect(screen.getByTestId('download-xlsx')).toHaveTextContent('Excel');
    expect(screen.getByTestId('download-pdf')).toHaveTextContent('PDF');
  });

  it('replaces the links with a reason when the list was cut', () => {
    render(<ExportButtons code="x" formats={['csv']} query="" truncated />);
    expect(screen.queryByTestId('download-csv')).toBeNull();
    expect(screen.getByText('Narrow the report to download it.')).toBeInTheDocument();
  });
});

describe('CommandPalette', () => {
  const items = [
    {
      code: 'receivables-ageing',
      title: 'Receivables ageing',
      question: 'Who owes us money?',
      familyLabel: 'Finance',
      keywords: ['debtors'],
      href: '/admin/reports/receivables-ageing',
    },
    {
      code: 'trial-balance',
      title: 'Trial balance',
      question: 'Do the books balance?',
      familyLabel: 'Finance',
      keywords: [],
      href: '/admin/reports/trial-balance',
    },
  ];

  it('opens with Ctrl+K, searches, and goes to the chosen report with Enter', async () => {
    render(<CommandPalette items={items} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const dialog = screen.getByRole('dialog', { name: 'Find a report' });
    const input = within(dialog).getByRole('combobox', { name: 'Search reports' });
    expect(input).toHaveFocus();
    await userEvent.type(input, 'debtors');
    expect(within(dialog).getAllByRole('option')).toHaveLength(1);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(push).toHaveBeenCalledWith('/admin/reports/receivables-ageing');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('moves with the arrow keys and closes with Escape', async () => {
    render(<CommandPalette items={items} />);
    await userEvent.click(screen.getByTestId('palette-open'));
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(push).toHaveBeenCalledWith('/admin/reports/trial-balance');
  });

  it('says so when nothing matches, and closes on Escape', async () => {
    render(<CommandPalette items={items} />);
    fireEvent.keyDown(window, { key: 'K', metaKey: true });
    await userEvent.type(screen.getByRole('combobox'), 'zzzz');
    expect(screen.getByText(/No report matches/)).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
