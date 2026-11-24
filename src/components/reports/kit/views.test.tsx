// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type {
  AnalysisReport,
  ReportFacts,
  StatementReport,
} from '@/server/domains/reports/analysis/types';
import { AnalysisView } from './AnalysisView';
import { BackButton } from './BackButton';
import { StatementView, statementCell } from './StatementView';
import { filterStateOf } from './report-filters';

const push = vi.fn();
const back = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, back }),
  usePathname: () => '/admin/reports/x',
  useSearchParams: () => new URLSearchParams(''),
}));

beforeEach(() => {
  push.mockClear();
  back.mockClear();
});
afterEach(cleanup);

const facts: ReportFacts = {
  preset: 'this_month',
  compare: 'previous_year',
  fromDate: '2026-03-01',
  toDate: '2026-03-10',
  previousFromDate: '2025-03-01',
  previousToDate: '2025-03-10',
  timeZone: 'Africa/Nairobi',
  baseCurrency: 'KES',
  scopeLabel: 'All branches',
  branchId: null,
  canPickBranch: true,
  notice: null,
};

const KES = { kind: 'money', currency: 'KES' } as const;

const analysis = (over: Partial<AnalysisReport> = {}): AnalysisReport => ({
  kind: 'analysis',
  facts,
  kpis: [
    { key: 'sales', label: 'Item sales', value: 650, unit: KES, previous: 500, upIsGood: true },
    { key: 'rate', label: 'Returning share', value: 50, unit: { kind: 'percent' }, previous: 40 },
    { key: 'none', label: 'Margin', value: null, unit: { kind: 'percent' } },
  ],
  charts: [
    {
      kind: 'ranked',
      title: 'Top products by sales',
      unit: KES,
      items: [
        {
          key: 'a',
          label: 'Soap',
          value: 400,
          note: '4 units',
          changePct: 100,
          href: '/admin/products/a',
        },
      ],
    },
  ],
  table: {
    title: 'Sales by product',
    columns: [
      { label: 'Product', kind: 'text' },
      { label: 'Sales (KES)', kind: 'money' },
    ],
    rows: [
      ['Soap', 400],
      ['Milk', 250],
    ],
    totals: ['Total', 650],
  },
  rowLinks: ['/admin/products/a', null],
  reconciliation: [
    { label: 'Items listed in this report', value: 650 },
    { label: 'Sales on the Business Overview', value: 766, strong: true },
  ],
  notes: ['A sale is an order that was not cancelled.'],
  truncated: false,
  ...over,
});

describe('AnalysisView', () => {
  it('draws the headline figures with their change on the comparison, in words', () => {
    render(<AnalysisView report={analysis()} />);
    const strip = screen.getByRole('region', { name: 'Headline figures' });
    expect(within(strip).getByText('Item sales')).toBeInTheDocument();
    expect(within(strip).getByText('KES 650')).toBeInTheDocument();
    expect(strip).toHaveTextContent(/Up 30% on the same period last year/);
    // A percentage figure says what it was, rather than a percentage of a percentage.
    expect(strip).toHaveTextContent('Was 40.0% in the same period last year');
    // A figure that cannot be worked out is a dash, never zero.
    expect(within(strip).getByText('–')).toBeInTheDocument();
  });

  it('makes a row with somewhere to go a link, and one without a plain row', () => {
    render(<AnalysisView report={analysis()} />);
    expect(
      screen
        .getAllByRole('link', { name: /Soap/ })
        .some((a) => a.getAttribute('href') === '/admin/products/a'),
    ).toBe(true);
    expect(screen.getAllByText('Milk').length).toBeGreaterThan(0);
  });

  it('proves the figure against the overview, with the overview line stressed', () => {
    render(<AnalysisView report={analysis()} />);
    const panel = screen.getByRole('region', { name: 'How this adds up to the Business Overview' });
    expect(within(panel).getByText('KES 766').closest('div')?.className).toMatch(/font-bold/);
  });

  it('heads the table by what a row is, not by the report title again', () => {
    render(<AnalysisView report={analysis()} />);
    expect(screen.getByRole('heading', { name: 'By product' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sales by product' })).toBeNull();
  });

  it('says what is counted', () => {
    render(<AnalysisView report={analysis()} />);
    expect(screen.getByText('A sale is an order that was not cancelled.')).toBeInTheDocument();
  });

  it('says there is nothing, instead of drawing empty charts, when there are no rows', () => {
    render(
      <AnalysisView
        report={analysis({
          table: { title: 't', columns: [{ label: 'x', kind: 'text' }], rows: [] },
          rowLinks: [],
          charts: [],
          reconciliation: [],
        })}
      />,
    );
    expect(screen.getByText(/Nothing recorded for these dates/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows a notice when the period asked for could not be used', () => {
    render(
      <AnalysisView
        report={analysis({
          facts: { ...facts, notice: 'That range was too long, so 30 days are shown.' },
        })}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('That range was too long');
  });
});

const statement = (checkOk: boolean): StatementReport => ({
  kind: 'statement',
  facts,
  basis: 'period',
  columns: [
    { key: 'now', label: 'This period', kind: 'money' },
    { key: 'before', label: 'Before', kind: 'money' },
    { key: 'changePct', label: 'Change %', kind: 'percent' },
  ],
  lines: [
    { key: 'h', label: 'Revenue', indent: 0, kind: 'heading', values: [null, null, null] },
    {
      key: 'sales',
      label: 'Sales of goods',
      indent: 2,
      kind: 'line',
      values: [2000, 1500, 33.3],
      shares: [100, 100, null],
    },
    { key: 'cos', label: 'Cost of sales', indent: 2, kind: 'line', values: [-600, null, null] },
    { key: 'gross', label: 'Gross profit', indent: 0, kind: 'total', values: [1400, 1000, 40] },
  ],
  checks: [
    {
      key: 'c',
      label: 'Net profit equals the ledger',
      ok: checkOk,
      detail: 'Statement 1.00, ledger 2.00',
    },
  ],
  kpis: [
    { key: 'gp', label: 'Gross profit', value: 1400, unit: KES, previous: 1000, upIsGood: true },
  ],
  notes: ['Read from the general ledger.'],
  table: { title: 'Income statement', columns: [{ label: 'Line', kind: 'text' }], rows: [] },
});

describe('statementCell', () => {
  it('writes a negative amount in brackets, two decimals, and leaves a missing figure empty', () => {
    expect(statementCell(1234.5, 'money')).toBe('1,234.50');
    expect(statementCell(-600, 'money')).toBe('(600.00)');
    expect(statementCell(0, 'money')).toBe('0.00');
    expect(statementCell(null, 'money')).toBe('');
    expect(statementCell(33.3, 'percent')).toBe('33.3%');
  });
});

describe('StatementView', () => {
  it('draws a table with a row heading for every line, and shows the share of net sales', () => {
    render(<StatementView report={statement(true)} />);
    const table = screen.getByTestId('statement-table');
    expect(within(table).getByRole('rowheader', { name: 'Sales of goods' })).toBeInTheDocument();
    expect(within(table).getByText('(600.00)')).toBeInTheDocument();
    expect(within(table).getAllByText('100.0%').length).toBeGreaterThan(0);
  });

  it('draws the same lines as cards for a phone', () => {
    render(<StatementView report={statement(true)} />);
    const list = screen.getByRole('list', { name: 'Income statement' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(4);
  });

  it('says a statement agrees with the books as a small mark, not a banner', () => {
    render(<StatementView report={statement(true)} />);
    expect(screen.getByRole('region', { name: 'Checks on this statement' })).toHaveTextContent(
      'Net profit equals the ledger',
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/Checked:/)).toBeNull();
  });

  it('shouts when a statement does not agree with the books, and shows both sides', () => {
    render(<StatementView report={statement(false)} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Does not agree');
    expect(alert).toHaveTextContent('Statement 1.00, ledger 2.00');
    expect(alert).toHaveTextContent('Do not rely on this statement');
  });
});

describe('the filter bar state of a report', () => {
  it('states the period and the comparison in words and offers the branch choice only to those who may', () => {
    const state = filterStateOf(facts, '10 Mar, 18:00');
    expect(state.rangeLabel).toBe('1 Mar 2026 – 10 Mar 2026');
    expect(state.compareRangeLabel).toBe('1 Mar 2025 – 10 Mar 2025');
    expect(state.presets.map((p) => p.value)).not.toContain('custom');
    expect(state.canPickBranch).toBe(true);
    expect(filterStateOf({ ...facts, canPickBranch: false }, 'x').canPickBranch).toBe(false);
    expect(filterStateOf({ ...facts, branchId: 'b1', scopeLabel: 'Mombasa' }, 'x').branch).toEqual({
      id: 'b1',
      name: 'Mombasa',
    });
  });
});

describe('BackButton', () => {
  beforeEach(() => {
    Reflect.deleteProperty(window, 'navigation');
  });

  const referrer = (value: string) => {
    Object.defineProperty(document, 'referrer', { value, configurable: true });
  };

  it('goes back when the person came from another page of the app', () => {
    referrer(`${window.location.origin}/admin`);
    window.history.pushState({}, '', '/admin/reports/x');
    render(<BackButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(back).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });

  it('goes to the list of reports when the page was opened directly', () => {
    referrer('');
    render(<BackButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(push).toHaveBeenCalledWith('/admin/reports');
    expect(back).not.toHaveBeenCalled();
  });

  it('asks the browser first: a move inside the app counts even though the first page had no referrer', () => {
    referrer('');
    Object.defineProperty(window, 'navigation', { value: { canGoBack: true }, configurable: true });
    render(<BackButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(back).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });

  it('goes to the list when the browser says there is nothing earlier', () => {
    referrer(`${window.location.origin}/admin`);
    Object.defineProperty(window, 'navigation', {
      value: { canGoBack: false },
      configurable: true,
    });
    render(<BackButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(push).toHaveBeenCalledWith('/admin/reports');
    expect(back).not.toHaveBeenCalled();
  });

  it('does not trust a link from another site', () => {
    referrer('https://elsewhere.example/page');
    render(<BackButton fallbackHref="/admin/reports" />);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(push).toHaveBeenCalledWith('/admin/reports');
  });
});
