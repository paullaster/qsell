import { describe, expect, it } from 'vitest';
import type { ChartAccount, Nets } from './ledger-queries';
import {
  buildBalanceSheet,
  buildCashFlow,
  buildEquityChanges,
  buildIncomeStatement,
  type PeriodNets,
} from './statements';
import type { ReportFacts, StatementReport } from './types';

const facts: ReportFacts = {
  preset: 'this_year',
  compare: 'previous_period',
  fromDate: '2026-01-01',
  toDate: '2026-12-31',
  previousFromDate: '2025-01-01',
  previousToDate: '2025-12-31',
  timeZone: 'Africa/Nairobi',
  baseCurrency: 'KES',
  scopeLabel: 'All branches',
  branchId: null,
  canPickBranch: true,
  notice: null,
};

type Cat = ChartAccount['category'];
const acct = (
  id: string,
  name: string,
  category: Cat,
  group: string,
  normal: 'debit' | 'credit' = 'debit',
): ChartAccount => ({
  id,
  no: id,
  name,
  category,
  normal,
  group,
  groupNo: group,
});

const chart: ChartAccount[] = [
  acct('cash', 'Cash on hand', 'assets', 'Cash and bank'),
  acct('ar', 'Trade debtors', 'assets', 'Receivables'),
  acct('inv', 'Inventory', 'assets', 'Inventory'),
  acct('ppe', 'Equipment and fittings', 'assets', 'Property, plant and equipment'),
  acct('dep', 'Accumulated depreciation', 'assets', 'Property, plant and equipment', 'credit'),
  acct('ap', 'Trade creditors', 'liabilities', 'Payables', 'credit'),
  acct('loan', 'Loans', 'liabilities', 'Borrowings', 'credit'),
  acct('cap', 'Share capital', 'equity', 'Equity', 'credit'),
  acct('ret', 'Retained earnings', 'equity', 'Equity', 'credit'),
  acct('draw', 'Owner drawings / dividends', 'equity', 'Equity'),
  acct('sales', 'Sales of goods', 'income', 'Income', 'credit'),
  acct('returns', 'Sales returns', 'income', 'Income'),
  acct('other', 'Other income', 'income', 'Income', 'credit'),
  acct('cogs', 'Cost of goods sold', 'cost_of_sales', 'Cost of sales'),
  acct('rent', 'Rent and utilities', 'expense', 'Expenses'),
  acct('depx', 'Depreciation', 'expense', 'Expenses'),
];

const k = (n: number): bigint => BigInt(Math.round(n * 10_000));
/** Net-debit amounts by account (debit positive). */
const nets = (entries: Record<string, number>): Nets =>
  new Map(Object.entries(entries).map(([id, v]) => [id, k(v)]));
const plus = (a: Nets, b: Nets): Nets => {
  const out = new Map(a);
  for (const [id, v] of b) out.set(id, (out.get(id) ?? 0n) + v);
  return out;
};

// One year of balanced transactions on top of an opening position of cash 1,000 against capital 1,000.
const opening = nets({ cash: 1000, cap: -1000 });
const movement = nets({
  cash: 500 + 300 - 400 + 1500 - 500 - 200 - 100 + 50, // 1,150
  cap: -500,
  loan: -300,
  ppe: 400,
  ar: 2000 - 1500,
  sales: -2000,
  inv: 800 - 600,
  ap: -800 + 500,
  cogs: 600,
  rent: 200,
  depx: 40,
  dep: -40,
  draw: 100,
  other: -50,
});
const closing = plus(opening, movement);
const empty: Nets = new Map();

const period: PeriodNets = { open: opening, close: closing, move: movement };
const noPeriod: PeriodNets = { open: empty, close: empty, move: empty };

const val = (s: StatementReport, key: string, col = 0): number | null =>
  s.lines.find((l) => l.key === key)?.values[col] ?? null;

describe('the books used here balance', () => {
  it('has debits equal to credits in the movement and in the closing position', () => {
    const sum = (n: Nets) => [...n.values()].reduce((a, v) => a + v, 0n);
    expect(sum(movement)).toBe(0n);
    expect(sum(closing)).toBe(0n);
  });
});

describe('income statement', () => {
  const s = buildIncomeStatement({
    facts,
    chart,
    revenueIds: new Set(['sales', 'returns']),
    now: movement,
    before: empty,
    nowLabel: '2026',
    beforeLabel: '2025',
  });

  it('works through net sales, gross profit, operating profit and net profit', () => {
    expect(val(s, 'net-sales')).toBe(2000);
    expect(val(s, 'cost-total')).toBe(600);
    expect(val(s, 'gross')).toBe(1400);
    expect(val(s, 'exp-total')).toBe(240);
    expect(val(s, 'operating')).toBe(1160);
    expect(val(s, 'other-total')).toBe(50);
    expect(val(s, 'net-profit')).toBe(1210);
  });

  it('shows each line as a share of net sales', () => {
    const gross = s.lines.find((l) => l.key === 'gross');
    expect(gross?.shares?.[0]).toBe(70);
    expect(s.lines.find((l) => l.key === 'net-profit')?.shares?.[0]).toBe(60.5);
  });

  it('proves its profit against the profit and loss accounts of the ledger', () => {
    expect(s.checks).toEqual([expect.objectContaining({ key: 'ties-to-ledger', ok: true })]);
  });

  it('leaves out an account with nothing in either column, and shows a change against a quiet comparison as blank', () => {
    expect(s.lines.some((l) => l.key === 'rev-returns')).toBe(false);
    expect(s.lines.find((l) => l.key === 'net-profit')?.values[3]).toBeNull();
  });

  it('treats every income account as revenue when the posting setup names none', () => {
    const t = buildIncomeStatement({
      facts,
      chart,
      revenueIds: new Set(),
      now: movement,
      before: empty,
      nowLabel: 'a',
      beforeLabel: 'b',
    });
    expect(val(t, 'net-sales')).toBe(2050);
    expect(t.lines.some((l) => l.key === 'other')).toBe(false);
    expect(val(t, 'net-profit')).toBe(1210);
  });

  it('carries the same lines into the downloadable table', () => {
    expect(s.table.rows).toHaveLength(s.lines.length);
    expect(s.table.columns[0]?.label).toBe('Line');
  });
});

describe('balance sheet', () => {
  const s = buildBalanceSheet({
    facts,
    chart,
    now: closing,
    before: opening,
    nowLabel: '31 Dec 2026',
    beforeLabel: '31 Dec 2025',
    nowYearOpening: opening,
    beforeYearOpening: empty,
  });

  it('adds assets, liabilities and equity, with the unclosed profit inside equity', () => {
    expect(val(s, 'assets-total')).toBe(3210);
    expect(val(s, 'liabilities-total')).toBe(600);
    expect(val(s, 'this-year')).toBe(1210);
    expect(val(s, 'equity-total')).toBe(2610);
    expect(val(s, 'liabilities-equity')).toBe(3210);
  });

  it('balances, and says so', () => {
    expect(s.checks).toEqual([expect.objectContaining({ key: 'balances', ok: true })]);
  });

  it('nets the accumulated depreciation against equipment and groups as the chart does', () => {
    expect(val(s, 'assets-Property, plant and equipment-total')).toBe(360);
    expect(s.lines.find((l) => l.key === 'assets-Cash and bank')?.kind).toBe('heading');
  });

  it('reports a sheet that does not balance instead of hiding it', () => {
    const broken = new Map(closing);
    broken.set('cash', (broken.get('cash') ?? 0n) + k(5));
    const t = buildBalanceSheet({
      facts,
      chart,
      now: broken,
      before: opening,
      nowLabel: 'a',
      beforeLabel: 'b',
      nowYearOpening: null,
      beforeYearOpening: null,
    });
    expect(t.checks[0]?.ok).toBe(false);
    expect(t.checks[0]?.detail).toContain('3215.00');
  });
});

describe('statement of changes in equity', () => {
  const s = buildEquityChanges({
    facts,
    chart,
    open: opening,
    close: closing,
    move: movement,
    openDate: '31 Dec 2025',
    closeDate: '31 Dec 2026',
  });
  const row = (key: string) => s.lines.find((l) => l.key === key)?.values;

  it('rolls the opening equity forward by profit, capital and drawings to the closing equity', () => {
    expect(row('opening')).toEqual([1000, 0, 1000]);
    expect(row('profit')).toEqual([0, 1210, 1210]);
    expect(row('capital')).toEqual([500, 0, 500]);
    expect(row('drawings')).toEqual([0, -100, -100]);
    expect(row('closing')).toEqual([1500, 1110, 2610]);
  });

  it('proves the roll-forward, and its closing equals the balance sheet equity', () => {
    expect(s.checks[0]?.ok).toBe(true);
    expect(row('closing')?.[2]).toBe(2610);
  });

  it('shows year-end closing entries as an adjustment instead of hiding them', () => {
    // A closing entry moves the year's profit from the profit and loss accounts into retained earnings. It is an entry
    // in the period like any other, so the period's movement includes it.
    const closingEntry = nets({
      sales: 2000,
      cogs: -600,
      rent: -200,
      depx: -40,
      other: 50,
      ret: -1210,
    });
    const closed = plus(closing, closingEntry);
    const t = buildEquityChanges({
      facts,
      chart,
      open: opening,
      close: closed,
      move: plus(movement, closingEntry),
      openDate: 'a',
      closeDate: 'b',
    });
    expect(t.lines.some((l) => l.key === 'adjustments')).toBe(true);
    expect(t.checks[0]?.ok).toBe(true);
    expect(t.lines.find((l) => l.key === 'closing')?.values[2]).toBe(2610);
  });
});

describe('cash flow statement', () => {
  const s = buildCashFlow({
    facts,
    chart,
    cashIds: new Set(['cash']),
    now: period,
    before: noPeriod,
    nowLabel: '2026',
    beforeLabel: '2025',
  });

  it('starts from profit, adds back depreciation and adjusts for working capital', () => {
    expect(val(s, 'profit')).toBe(1210);
    expect(val(s, 'depreciation')).toBe(40);
    expect(val(s, 'wc-Receivables')).toBe(-500);
    expect(val(s, 'wc-Inventory')).toBe(-200);
    expect(val(s, 'wc-Payables')).toBe(300);
    expect(val(s, 'operating-total')).toBe(850);
  });

  it('puts equipment in investing and loans, capital and drawings in financing', () => {
    expect(val(s, 'investing-total')).toBe(-400);
    expect(val(s, 'financing-total')).toBe(700);
    expect(val(s, 'financing-loan')).toBe(300);
    expect(val(s, 'financing-cap')).toBe(500);
    expect(val(s, 'financing-draw')).toBe(-100);
  });

  it('ends on the cash and bank balance and proves it against the cash accounts', () => {
    expect(val(s, 'net-change')).toBe(1150);
    expect(val(s, 'opening-cash')).toBe(1000);
    expect(val(s, 'closing-cash')).toBe(2150);
    expect(s.checks).toEqual([expect.objectContaining({ key: 'matches-cash', ok: true })]);
  });

  it('flags a cash account that moved without the rest of the books', () => {
    const lopsided: PeriodNets = {
      ...period,
      close: new Map(closing).set('cash', (closing.get('cash') ?? 0n) + k(10)),
    };
    const t = buildCashFlow({
      facts,
      chart,
      cashIds: new Set(['cash']),
      now: lopsided,
      before: noPeriod,
      nowLabel: 'a',
      beforeLabel: 'b',
    });
    expect(t.checks[0]?.ok).toBe(false);
  });
});
