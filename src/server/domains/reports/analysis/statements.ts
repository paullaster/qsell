import type { ExportCell, ExportColumn, ExportTable } from '../export/table';
import type { ChartAccount, Net, Nets } from './ledger-queries';
import type { Kpi, ReportFacts, StatementCheck, StatementLine, StatementReport } from './types';

/**
 * The financial statements, built from ledger balances. Pure: nets in, a statement out. Amounts are whole scaled integers
 * ("net debit", debit positive) until the very edge, so every proof compares exact numbers. Groups and order follow the
 * company's own chart of accounts; nothing here knows an account number. Each statement carries the proofs that tell a reader
 * whether to trust it: the ones that fail are shown, never hidden.
 */

const ZERO = 0n;

/** Whole scaled amount to a display number with two decimals. */
export const money = (n: Net): number => Math.round(Number(n) / 100) / 100;

const get = (nets: Nets, id: string): Net => nets.get(id) ?? ZERO;

const sumOf = <T>(items: readonly T[], pick: (t: T) => Net): Net =>
  items.reduce((a, t) => a + pick(t), ZERO);

const PROFIT_AND_LOSS = new Set(['income', 'cost_of_sales', 'expense']);
export const isProfitAndLoss = (a: ChartAccount): boolean => PROFIT_AND_LOSS.has(a.category);

const RETAINED = /retain|earning|accumulated/i;
const DRAWINGS = /drawing|dividend/i;
const DEPRECIATION = /depreciation|amortis|amortiz/i;
const FIXED =
  /propert|plant|equipment|fixed|intangible|invest|vehicle|land|building|furniture|fittings/i;
const BORROWING = /loan|borrow|debenture|overdraft|lease|mortgage/i;

const pct = (part: Net, whole: Net): number | null =>
  whole === ZERO ? null : Number(((Number(part) / Number(whole)) * 100).toFixed(1));

// ---------------- shared shapes ----------------

type Col = StatementReport['columns'][number];

function comparisonColumns(nowLabel: string, beforeLabel: string): Col[] {
  return [
    { key: 'now', label: nowLabel, kind: 'money' },
    { key: 'before', label: beforeLabel, kind: 'money' },
    { key: 'change', label: 'Change', kind: 'money' },
    { key: 'changePct', label: 'Change %', kind: 'percent' },
  ];
}

/** The four figures of a comparison row from a pair of exact amounts. */
function pair(now: Net, before: Net): (number | null)[] {
  const change = now - before;
  return [
    money(now),
    money(before),
    money(change),
    before === ZERO ? null : pct(change, before < ZERO ? -before : before),
  ];
}

const heading = (key: string, label: string, indent: 0 | 1 = 0): StatementLine => ({
  key,
  label,
  indent,
  kind: 'heading',
  values: [null, null, null, null],
});

function line(
  key: string,
  label: string,
  now: Net,
  before: Net,
  kind: StatementLine['kind'] = 'line',
  indent: StatementLine['indent'] = 1,
  shares?: (number | null)[],
): StatementLine {
  return {
    key,
    label,
    indent,
    kind,
    values: pair(now, before),
    ...(shares === undefined ? {} : { shares }),
  };
}

/** A statement as the flat table a download carries: one row per line, one column per figure. */
function tableOf(
  title: string,
  columns: readonly Col[],
  lines: readonly StatementLine[],
): ExportTable {
  const cols: ExportColumn[] = [
    { label: 'Line', kind: 'text' },
    ...columns.map((c) => ({ label: c.label, kind: c.kind })),
  ];
  return {
    title,
    columns: cols,
    rows: lines.map((l) => [l.label, ...l.values] as ExportCell[]),
  };
}

const sectionOf = (
  accounts: readonly ChartAccount[],
): { group: string; accounts: ChartAccount[] }[] => {
  const order: string[] = [];
  const byGroup = new Map<string, ChartAccount[]>();
  for (const a of accounts) {
    const key = `${a.groupNo}|${a.group}`;
    if (!byGroup.has(key)) {
      byGroup.set(key, []);
      order.push(key);
    }
    byGroup.get(key)?.push(a);
  }
  return order.map((key) => ({
    group: key.slice(key.indexOf('|') + 1),
    accounts: byGroup.get(key) ?? [],
  }));
};

// ---------------- income statement ----------------

export interface IncomeInput {
  facts: ReportFacts;
  chart: readonly ChartAccount[];
  /** Accounts the posting setup names for sales, returns and discounts. Empty means every income account is revenue. */
  revenueIds: ReadonlySet<string>;
  now: Nets;
  before: Nets;
  nowLabel: string;
  beforeLabel: string;
}

export function buildIncomeStatement(input: IncomeInput): StatementReport {
  const { facts, chart } = input;
  const income = chart.filter((a) => a.category === 'income');
  const useRoles = input.revenueIds.size > 0;
  const revenue = useRoles ? income.filter((a) => input.revenueIds.has(a.id)) : income;
  const otherIncome = useRoles ? income.filter((a) => !input.revenueIds.has(a.id)) : [];
  const cost = chart.filter((a) => a.category === 'cost_of_sales');
  const expense = chart.filter((a) => a.category === 'expense');

  // Income is credit-positive, cost and expense are debit-positive: each is shown as a positive amount of what it is.
  const cr = (nets: Nets, a: ChartAccount): Net => -get(nets, a.id);
  const dr = (nets: Nets, a: ChartAccount): Net => get(nets, a.id);
  const total = (
    items: readonly ChartAccount[],
    nets: Nets,
    side: (n: Nets, a: ChartAccount) => Net,
  ): Net => sumOf(items, (a) => side(nets, a));
  const active = (a: ChartAccount, side: (n: Nets, a: ChartAccount) => Net): boolean =>
    side(input.now, a) !== ZERO || side(input.before, a) !== ZERO;

  const netSalesNow = total(revenue, input.now, cr);
  const netSalesBefore = total(revenue, input.before, cr);
  const share = (n: Net, b: Net): (number | null)[] => [
    pct(n, netSalesNow),
    pct(b, netSalesBefore),
    null,
    null,
  ];

  const lines: StatementLine[] = [];
  const accountLines = (
    items: readonly ChartAccount[],
    side: (n: Nets, a: ChartAccount) => Net,
    prefix: string,
  ) => {
    for (const a of items.filter((x) => active(x, side))) {
      const n = side(input.now, a);
      const b = side(input.before, a);
      lines.push(line(`${prefix}-${a.id}`, a.name, n, b, 'line', 2, share(n, b)));
    }
  };

  lines.push(heading('revenue', 'Revenue'));
  accountLines(revenue, cr, 'rev');
  lines.push(
    line(
      'net-sales',
      'Net sales',
      netSalesNow,
      netSalesBefore,
      'subtotal',
      1,
      share(netSalesNow, netSalesBefore),
    ),
  );

  lines.push(heading('cost', 'Cost of sales'));
  accountLines(cost, dr, 'cos');
  const costNow = total(cost, input.now, dr);
  const costBefore = total(cost, input.before, dr);
  lines.push(
    line(
      'cost-total',
      'Total cost of sales',
      costNow,
      costBefore,
      'subtotal',
      1,
      share(costNow, costBefore),
    ),
  );

  const grossNow = netSalesNow - costNow;
  const grossBefore = netSalesBefore - costBefore;
  lines.push(
    line('gross', 'Gross profit', grossNow, grossBefore, 'total', 0, share(grossNow, grossBefore)),
  );

  lines.push(heading('expenses', 'Operating expenses'));
  for (const g of sectionOf(expense)) {
    const rows = g.accounts.filter((a) => active(a, dr));
    if (rows.length === 0) continue;
    for (const a of rows) {
      const n = dr(input.now, a);
      const b = dr(input.before, a);
      lines.push(line(`exp-${a.id}`, a.name, n, b, 'line', 2, share(n, b)));
    }
  }
  const expNow = total(expense, input.now, dr);
  const expBefore = total(expense, input.before, dr);
  lines.push(
    line(
      'exp-total',
      'Total operating expenses',
      expNow,
      expBefore,
      'subtotal',
      1,
      share(expNow, expBefore),
    ),
  );

  const operatingNow = grossNow - expNow;
  const operatingBefore = grossBefore - expBefore;
  lines.push(
    line(
      'operating',
      'Operating profit',
      operatingNow,
      operatingBefore,
      'total',
      0,
      share(operatingNow, operatingBefore),
    ),
  );

  const otherNow = total(otherIncome, input.now, cr);
  const otherBefore = total(otherIncome, input.before, cr);
  if (otherIncome.some((a) => active(a, cr))) {
    lines.push(heading('other', 'Other income'));
    accountLines(otherIncome, cr, 'oth');
    lines.push(
      line(
        'other-total',
        'Total other income',
        otherNow,
        otherBefore,
        'subtotal',
        1,
        share(otherNow, otherBefore),
      ),
    );
  }

  const profitNow = operatingNow + otherNow;
  const profitBefore = operatingBefore + otherBefore;
  lines.push(
    line(
      'net-profit',
      'Net profit',
      profitNow,
      profitBefore,
      'total',
      0,
      share(profitNow, profitBefore),
    ),
  );

  // Proof: the statement's profit is exactly what the trial balance's profit-and-loss accounts add up to.
  const ledgerNow = -sumOf(chart.filter(isProfitAndLoss), (a) => get(input.now, a.id));
  const ledgerBefore = -sumOf(chart.filter(isProfitAndLoss), (a) => get(input.before, a.id));
  const checks: StatementCheck[] = [
    {
      key: 'ties-to-ledger',
      label: 'Net profit equals the profit and loss accounts of the trial balance',
      ok: ledgerNow === profitNow && ledgerBefore === profitBefore,
      detail: `Statement ${money(profitNow).toFixed(2)}, ledger ${money(ledgerNow).toFixed(2)}`,
    },
  ];

  const kpis: Kpi[] = [
    {
      key: 'net-sales',
      label: 'Net sales',
      value: money(netSalesNow),
      unit: { kind: 'money', currency: facts.baseCurrency },
      previous: money(netSalesBefore),
      upIsGood: true,
    },
    {
      key: 'gross',
      label: 'Gross profit',
      value: money(grossNow),
      unit: { kind: 'money', currency: facts.baseCurrency },
      previous: money(grossBefore),
      upIsGood: true,
    },
    {
      key: 'gross-margin',
      label: 'Gross margin',
      value: pct(grossNow, netSalesNow),
      unit: { kind: 'percent' },
      previous: pct(grossBefore, netSalesBefore),
      upIsGood: true,
    },
    {
      key: 'net-profit',
      label: 'Net profit',
      value: money(profitNow),
      unit: { kind: 'money', currency: facts.baseCurrency },
      previous: money(profitBefore),
      upIsGood: true,
    },
    {
      key: 'net-margin',
      label: 'Net margin',
      value: pct(profitNow, netSalesNow),
      unit: { kind: 'percent' },
      previous: pct(profitBefore, netSalesBefore),
      upIsGood: true,
    },
  ];

  const columns = [...comparisonColumns(input.nowLabel, input.beforeLabel)];
  return {
    kind: 'statement',
    facts,
    basis: 'period',
    columns,
    lines,
    checks,
    kpis,
    notes: [
      'Read from the general ledger by the date each entry was posted, so it agrees with the trial balance for the same dates.',
      useRoles
        ? 'Revenue is the accounts the posting setup uses for sales, sales returns and discounts; any other income sits under Other income.'
        : 'No sales accounts are set in the posting setup, so every income account is treated as revenue.',
      'Cost of sales is what the ledger holds for it: it follows the stock posting. If stock posting is not yet live, cost of sales and gross profit are understated.',
      'The percentage beside each line is its share of net sales.',
    ],
    table: tableOf('Income statement', columns, lines),
  };
}

// ---------------- balance sheet ----------------

export interface BalanceSheetInput {
  facts: ReportFacts;
  chart: readonly ChartAccount[];
  now: Nets;
  before: Nets;
  nowLabel: string;
  beforeLabel: string;
  /** Profit and loss accounts as they stood the day before the fiscal year began (for splitting earlier years from this one). */
  nowYearOpening: Nets | null;
  beforeYearOpening: Nets | null;
}

export function buildBalanceSheet(input: BalanceSheetInput): StatementReport {
  const { facts, chart } = input;
  const assets = chart.filter((a) => a.category === 'assets');
  const liabilities = chart.filter((a) => a.category === 'liabilities');
  const equity = chart.filter((a) => a.category === 'equity');
  const pl = chart.filter(isProfitAndLoss);

  const debit = (nets: Nets, a: ChartAccount): Net => get(nets, a.id);
  const credit = (nets: Nets, a: ChartAccount): Net => -get(nets, a.id);

  const lines: StatementLine[] = [];
  const section = (
    key: string,
    label: string,
    accounts: readonly ChartAccount[],
    side: (n: Nets, a: ChartAccount) => Net,
  ): { now: Net; before: Net } => {
    lines.push(heading(key, label));
    for (const g of sectionOf(accounts)) {
      const rows = g.accounts.filter(
        (a) => side(input.now, a) !== ZERO || side(input.before, a) !== ZERO,
      );
      if (rows.length === 0) continue;
      lines.push(heading(`${key}-${g.group}`, g.group, 1));
      for (const a of rows) {
        lines.push(
          line(`${key}-${a.id}`, a.name, side(input.now, a), side(input.before, a), 'line', 2),
        );
      }
      lines.push(
        line(
          `${key}-${g.group}-total`,
          `Total ${g.group.toLowerCase()}`,
          sumOf(rows, (a) => side(input.now, a)),
          sumOf(rows, (a) => side(input.before, a)),
          'subtotal',
          1,
        ),
      );
    }
    return {
      now: sumOf(accounts, (a) => side(input.now, a)),
      before: sumOf(accounts, (a) => side(input.before, a)),
    };
  };

  const a = section('assets', 'Assets', assets, debit);
  lines.push(line('assets-total', 'Total assets', a.now, a.before, 'total', 0));

  const l = section('liabilities', 'Liabilities', liabilities, credit);
  lines.push(line('liabilities-total', 'Total liabilities', l.now, l.before, 'total', 0));

  // Equity: the accounts as booked, then the profit that has not yet been closed into retained earnings.
  const e = section('equity', 'Equity', equity, credit);
  const plNow = -sumOf(pl, (x) => get(input.now, x.id));
  const plBefore = -sumOf(pl, (x) => get(input.before, x.id));
  let earlierNow = ZERO;
  let earlierBefore = ZERO;
  if (input.nowYearOpening !== null && input.beforeYearOpening !== null) {
    earlierNow = -sumOf(pl, (x) => get(input.nowYearOpening ?? new Map<string, bigint>(), x.id));
    earlierBefore = -sumOf(pl, (x) =>
      get(input.beforeYearOpening ?? new Map<string, bigint>(), x.id),
    );
  }
  const yearNow = plNow - earlierNow;
  const yearBefore = plBefore - earlierBefore;
  if (earlierNow !== ZERO || earlierBefore !== ZERO) {
    lines.push(
      line(
        'earlier-years',
        'Profit of earlier years, not yet closed to retained earnings',
        earlierNow,
        earlierBefore,
        'line',
        1,
      ),
    );
  }
  lines.push(line('this-year', 'Profit for the year to date', yearNow, yearBefore, 'line', 1));
  const equityNow = e.now + plNow;
  const equityBefore = e.before + plBefore;
  lines.push(line('equity-total', 'Total equity', equityNow, equityBefore, 'total', 0));
  lines.push(
    line(
      'liabilities-equity',
      'Total liabilities and equity',
      l.now + equityNow,
      l.before + equityBefore,
      'total',
      0,
    ),
  );

  const checks: StatementCheck[] = [
    {
      key: 'balances',
      label: 'Assets equal liabilities plus equity',
      ok: a.now === l.now + equityNow && a.before === l.before + equityBefore,
      detail: `Assets ${money(a.now).toFixed(2)}, liabilities and equity ${money(l.now + equityNow).toFixed(2)}`,
    },
  ];
  const cur = { kind: 'money', currency: facts.baseCurrency } as const;
  const columns = comparisonColumns(input.nowLabel, input.beforeLabel);
  return {
    kind: 'statement',
    facts,
    basis: 'date',
    columns,
    lines,
    checks,
    kpis: [
      {
        key: 'assets',
        label: 'Total assets',
        value: money(a.now),
        unit: cur,
        previous: money(a.before),
        upIsGood: true,
      },
      {
        key: 'liabilities',
        label: 'Total liabilities',
        value: money(l.now),
        unit: cur,
        previous: money(l.before),
        upIsGood: false,
      },
      {
        key: 'equity',
        label: 'Total equity',
        value: money(equityNow),
        unit: cur,
        previous: money(equityBefore),
        upIsGood: true,
      },
    ],
    notes: [
      'Balances are as at the end of the day shown, from everything posted up to and including that day.',
      'Profit that has not been closed into retained earnings by a year-end closing is shown inside equity, so the sheet always balances.',
      'Accounts with no balance on either date are left out. Groups follow your chart of accounts.',
    ],
    table: tableOf('Balance sheet', columns, lines),
  };
}

// ---------------- statement of changes in equity ----------------

export interface EquityInput {
  facts: ReportFacts;
  chart: readonly ChartAccount[];
  /** Balances the day before the period starts, and at its end. */
  open: Nets;
  close: Nets;
  /** Profit and loss movement inside the period. */
  move: Nets;
  openDate: string;
  closeDate: string;
}

export function buildEquityChanges(input: EquityInput): StatementReport {
  const { facts, chart } = input;
  const equity = chart.filter((a) => a.category === 'equity');
  const pl = chart.filter(isProfitAndLoss);
  const isRetained = (a: ChartAccount): boolean => RETAINED.test(a.name) || DRAWINGS.test(a.name);
  const capital = equity.filter((a) => !isRetained(a));
  const retained = equity.filter((a) => RETAINED.test(a.name) && !DRAWINGS.test(a.name));
  const drawings = equity.filter((a) => DRAWINGS.test(a.name));

  const cr = (nets: Nets, a: ChartAccount): Net => -get(nets, a.id);
  const at = (nets: Nets, items: readonly ChartAccount[]): Net => sumOf(items, (a) => cr(nets, a));
  const unclosed = (nets: Nets): Net => -sumOf(pl, (a) => get(nets, a.id));

  const columns: Col[] = [
    { key: 'capital', label: 'Capital and other equity', kind: 'money' },
    { key: 'retained', label: 'Retained earnings', kind: 'money' },
    { key: 'total', label: 'Total equity', kind: 'money' },
  ];
  const row = (
    key: string,
    label: string,
    cap: Net,
    ret: Net,
    kind: StatementLine['kind'] = 'line',
    indent: StatementLine['indent'] = 1,
  ): StatementLine => ({
    key,
    label,
    indent,
    kind,
    values: [money(cap), money(ret), money(cap + ret)],
  });

  const openCap = at(input.open, capital);
  const openRet = at(input.open, [...retained, ...drawings]) + unclosed(input.open);
  const profit = -sumOf(pl, (a) => get(input.move, a.id));
  const capMove = at(input.close, capital) - openCap;
  const drawMove = at(input.close, drawings) - at(input.open, drawings);
  const retMove = at(input.close, retained) - at(input.open, retained);
  const closeCap = at(input.close, capital);
  const closeRet = at(input.close, [...retained, ...drawings]) + unclosed(input.close);

  const lines: StatementLine[] = [
    row('opening', `Balance at ${input.openDate}`, openCap, openRet, 'subtotal', 0),
    row('profit', 'Profit for the period', ZERO, profit),
    row('capital', 'Capital introduced or withdrawn, and other movements', capMove, ZERO),
    row('drawings', 'Owner drawings and dividends', ZERO, drawMove),
  ];
  // Anything booked straight to a retained earnings account (an adjustment, or a year-end closing entry).
  const adjustments = retMove;
  if (adjustments !== ZERO) {
    lines.push(row('adjustments', 'Adjustments and year-end closing entries', ZERO, adjustments));
  }
  lines.push(row('closing', `Balance at ${input.closeDate}`, closeCap, closeRet, 'total', 0));

  const checks: StatementCheck[] = [
    {
      key: 'rolls-forward',
      label: 'Opening balance plus the movements equals the closing balance',
      // The profit is worked out from the period's movements and the closing balance from the balances: they must agree.
      ok: openCap + capMove === closeCap && openRet + profit + drawMove + adjustments === closeRet,
      detail: `Closing ${money(closeCap + closeRet).toFixed(2)}`,
    },
  ];
  const cur = { kind: 'money', currency: facts.baseCurrency } as const;
  return {
    kind: 'statement',
    facts,
    basis: 'period',
    columns,
    lines,
    checks,
    kpis: [
      { key: 'opening', label: 'Opening equity', value: money(openCap + openRet), unit: cur },
      {
        key: 'profit',
        label: 'Profit for the period',
        value: money(profit),
        unit: cur,
        upIsGood: true,
      },
      {
        key: 'drawings',
        label: 'Drawings and dividends',
        value: money(-drawMove),
        unit: cur,
        upIsGood: false,
      },
      { key: 'closing', label: 'Closing equity', value: money(closeCap + closeRet), unit: cur },
    ],
    notes: [
      'Retained earnings include profit of earlier years that has not been closed by a year-end closing, so the closing balance equals equity on the balance sheet.',
      'Owner drawings and dividends reduce retained earnings. Share capital and any other equity account sit under Capital and other equity.',
    ],
    table: tableOf('Statement of changes in equity', columns, lines),
  };
}

// ---------------- cash flow ----------------

export interface PeriodNets {
  /** Balances the day before the period starts, and at its end. */
  open: Nets;
  close: Nets;
  /** Movement of every account inside the period. */
  move: Nets;
}

export interface CashFlowInput {
  facts: ReportFacts;
  chart: readonly ChartAccount[];
  cashIds: ReadonlySet<string>;
  now: PeriodNets;
  before: PeriodNets;
  nowLabel: string;
  beforeLabel: string;
}

type Activity = 'operating' | 'investing' | 'financing';

function activityOf(a: ChartAccount): Activity {
  if (a.category === 'equity') return 'financing';
  if (a.category === 'liabilities')
    return BORROWING.test(a.group) || BORROWING.test(a.name) ? 'financing' : 'operating';
  return FIXED.test(a.group) || FIXED.test(a.name) ? 'investing' : 'operating';
}

export function buildCashFlow(input: CashFlowInput): StatementReport {
  const { facts, chart } = input;
  const pl = chart.filter(isProfitAndLoss);
  const cash = chart.filter((a) => input.cashIds.has(a.id));
  const others = chart.filter((a) => !isProfitAndLoss(a) && !input.cashIds.has(a.id));

  const delta = (p: PeriodNets, a: ChartAccount): Net => get(p.close, a.id) - get(p.open, a.id);
  /** What an account's change means for cash: an asset that grew took cash, a liability that grew gave it. */
  const inflow = (p: PeriodNets, a: ChartAccount): Net => -delta(p, a);
  const profit = (p: PeriodNets): Net => -sumOf(pl, (a) => get(p.move, a.id));

  const isDepreciation = (a: ChartAccount): boolean =>
    a.category === 'assets' && DEPRECIATION.test(a.name);
  const isRetained = (a: ChartAccount): boolean => a.category === 'equity' && RETAINED.test(a.name);

  const lines: StatementLine[] = [];
  const both = (fn: (p: PeriodNets) => Net) => [fn(input.now), fn(input.before)] as const;
  const put = (
    key: string,
    label: string,
    fn: (p: PeriodNets) => Net,
    kind: StatementLine['kind'] = 'line',
    indent: StatementLine['indent'] = 1,
  ) => {
    const [n, b] = both(fn);
    lines.push(line(key, label, n, b, kind, indent));
    return [n, b] as const;
  };

  lines.push(heading('operating', 'Cash flows from operating activities'));
  put('profit', 'Net profit for the period', profit);
  const depr = others.filter(isDepreciation);
  const [deprNow, deprBefore] = put(
    'depreciation',
    'Add back: depreciation and amortisation (not cash)',
    (p) => sumOf(depr, (a) => inflow(p, a)),
  );

  const closing = others.filter(isRetained);
  const [closeNow, closeBefore] = put(
    'closing-entries',
    'Retained earnings: year-end closing entries',
    (p) => sumOf(closing, (a) => inflow(p, a)),
  );

  let operatingNow = profit(input.now) + deprNow + closeNow;
  let operatingBefore = profit(input.before) + deprBefore + closeBefore;
  const working = others.filter(
    (a) => !isDepreciation(a) && !isRetained(a) && activityOf(a) === 'operating',
  );
  for (const g of sectionOf(working)) {
    const n = sumOf(g.accounts, (a) => inflow(input.now, a));
    const b = sumOf(g.accounts, (a) => inflow(input.before, a));
    if (n === ZERO && b === ZERO) continue;
    const isAsset = g.accounts[0]?.category === 'assets';
    lines.push(
      line(
        `wc-${g.group}`,
        `${isAsset ? '(Increase) / decrease in' : 'Increase / (decrease) in'} ${g.group.toLowerCase()}`,
        n,
        b,
        'line',
        1,
      ),
    );
    operatingNow += n;
    operatingBefore += b;
  }
  lines.push(
    line(
      'operating-total',
      'Net cash from operating activities',
      operatingNow,
      operatingBefore,
      'total',
      0,
    ),
  );

  const accountsOf = (activity: Activity) =>
    others.filter((a) => !isDepreciation(a) && !isRetained(a) && activityOf(a) === activity);
  const activityBlock = (
    activity: Exclude<Activity, 'operating'>,
    key: string,
    title: string,
    totalLabel: string,
  ) => {
    lines.push(heading(key, title));
    let n = ZERO;
    let b = ZERO;
    for (const a of accountsOf(activity)) {
      const an = inflow(input.now, a);
      const ab = inflow(input.before, a);
      if (an === ZERO && ab === ZERO) continue;
      lines.push(line(`${key}-${a.id}`, a.name, an, ab, 'line', 1));
      n += an;
      b += ab;
    }
    lines.push(line(`${key}-total`, totalLabel, n, b, 'total', 0));
    return [n, b] as const;
  };
  const [invNow, invBefore] = activityBlock(
    'investing',
    'investing',
    'Cash flows from investing activities',
    'Net cash from investing activities',
  );
  const [finNow, finBefore] = activityBlock(
    'financing',
    'financing',
    'Cash flows from financing activities',
    'Net cash from financing activities',
  );

  const derivedNow = operatingNow + invNow + finNow;
  const derivedBefore = operatingBefore + invBefore + finBefore;
  lines.push(
    line('net-change', 'Net increase / (decrease) in cash', derivedNow, derivedBefore, 'total', 0),
  );
  const openCashNow = sumOf(cash, (a) => get(input.now.open, a.id));
  const openCashBefore = sumOf(cash, (a) => get(input.before.open, a.id));
  lines.push(
    line(
      'opening-cash',
      'Cash and bank at the start of the period',
      openCashNow,
      openCashBefore,
      'line',
      1,
    ),
  );
  lines.push(
    line(
      'closing-cash',
      'Cash and bank at the end of the period',
      openCashNow + derivedNow,
      openCashBefore + derivedBefore,
      'total',
      0,
    ),
  );

  const actualNow = sumOf(cash, (a) => delta(input.now, a));
  const actualBefore = sumOf(cash, (a) => delta(input.before, a));
  const checks: StatementCheck[] = [
    {
      key: 'matches-cash',
      label: 'The change in cash agrees with the movement on the cash and bank accounts',
      ok: derivedNow === actualNow && derivedBefore === actualBefore,
      detail: `Statement ${money(derivedNow).toFixed(2)}, cash and bank accounts ${money(actualNow).toFixed(2)}`,
    },
  ];
  const cur = { kind: 'money', currency: facts.baseCurrency } as const;
  const columns = comparisonColumns(input.nowLabel, input.beforeLabel);
  return {
    kind: 'statement',
    facts,
    basis: 'period',
    columns,
    lines,
    checks,
    kpis: [
      {
        key: 'operating',
        label: 'Cash from operations',
        value: money(operatingNow),
        unit: cur,
        previous: money(operatingBefore),
        upIsGood: true,
      },
      {
        key: 'investing',
        label: 'Cash from investing',
        value: money(invNow),
        unit: cur,
        previous: money(invBefore),
      },
      {
        key: 'financing',
        label: 'Cash from financing',
        value: money(finNow),
        unit: cur,
        previous: money(finBefore),
      },
      {
        key: 'closing',
        label: 'Cash at the end',
        value: money(openCashNow + derivedNow),
        unit: cur,
        previous: money(openCashBefore + derivedBefore),
        upIsGood: true,
      },
    ],
    notes: [
      'Indirect method: it starts from net profit and explains the change in cash by what happened to everything else on the balance sheet.',
      'Cash and bank means the accounts your payment methods post to, and the cash and bank group of your chart.',
      'Asset and liability accounts are sorted into operating, investing (property, plant and equipment) and financing (loans, share capital, drawings) by their names and groups in your chart. Everything unmatched is operating, so the statement always adds up to the change in cash.',
    ],
    table: tableOf('Cash flow statement', columns, lines),
  };
}
