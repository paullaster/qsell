import { describe, expect, it } from 'vitest';
import { convert, formatAmount, formatForDisplay, parseAmount, roundTo } from './amount';
import { compareAccountNo, matchesTotaling, totalBalance, validateChart } from './chart';
import { registerHash, GENESIS_HASH } from './hash';
import { validatePosting, type AccountFacts, type PostingPolicy } from './journal';
import { addDays, addMonths, checkPeriodsTile, generatePeriods } from './periods';
import { periodTransition } from './periods-status';
import { resolveCustomer, resolveGeneral, SetupMissingError } from './setup';
import { CHART_TEMPLATES } from './templates';
import type { PostingRequest } from './types';

describe('amounts', () => {
  it('parses and formats exactly', () => {
    expect(formatAmount(parseAmount('12.5'))).toBe('12.5000');
    expect(formatAmount(parseAmount('-0.0001'))).toBe('-0.0001');
    expect(parseAmount(0.1) + parseAmount(0.2)).toBe(parseAmount('0.3'));
    expect(() => parseAmount('1.00005')).toThrow();
    expect(() => parseAmount('abc')).toThrow();
  });
  it('rounds half to even', () => {
    expect(formatForDisplay(parseAmount('2.5'), 0)).toBe('2');
    expect(formatForDisplay(parseAmount('3.5'), 0)).toBe('4');
    expect(formatForDisplay(parseAmount('1.005'), 2)).toBe('1.00');
    expect(roundTo(parseAmount('-2.5'), 0)).toBe(parseAmount('-2'));
  });
  it('converts by a rate', () => {
    expect(formatAmount(convert(parseAmount('100'), '129.5'))).toBe('12950.0000');
    expect(formatAmount(convert(parseAmount('0.3333'), '3'))).toBe('0.9999');
    expect(formatAmount(convert(parseAmount('-10'), '0.5'))).toBe('-5.0000');
  });
});

const account = (over: Partial<AccountFacts> & { id: string }): AccountFacts => ({
  no: over.id,
  name: `Account ${over.id}`,
  type: 'posting',
  blocked: false,
  directPosting: true,
  postingSource: 'manual',
  currencyPolicy: 'any',
  dimensionRule: 'none',
  ...over,
});

const policy = (over: Partial<PostingPolicy> = {}): PostingPolicy => ({
  baseCurrency: 'KES',
  period: { id: 'p1', status: 'open', startsOn: '2026-10-01', endsOn: '2026-10-31' },
  window: { from: null, to: null },
  canPostSoftClosed: false,
  canPostControlAccounts: false,
  accounts: new Map(
    [
      account({ id: 'cash', postingSource: 'engine_only' }),
      account({ id: 'sales' }),
      account({ id: 'rent' }),
      account({ id: 'head', type: 'heading' }),
      account({ id: 'frozen', blocked: true }),
      account({ id: 'nodirect', directPosting: false }),
      account({ id: 'usd', currencyPolicy: 'USD' }),
      account({ id: 'dimreq', dimensionRule: 'required' }),
      account({ id: 'dimno', dimensionRule: 'forbidden' }),
    ].map((a) => [a.id, a]),
  ),
  ...over,
});

const req = (lines: [string, string, string][], over: Partial<PostingRequest> = {}): PostingRequest => ({
  companyId: 'c',
  idempotencyKey: 'k',
  postingDate: '2026-10-12',
  documentType: 'journal',
  documentNo: 'J1',
  currency: 'KES',
  rate: '1',
  rateSource: 'base',
  chainKey: 'general',
  origin: { surface: 'test', action: 'post' },
  postedBy: 'user',
  lines: lines.map(([accountId, debit, credit]) => ({ accountId, debit, credit })),
  ...over,
});

const codes = (r: ReturnType<typeof validatePosting>) => (r.ok ? [] : r.issues.map((i) => i.code));

describe('journal validation', () => {
  it('accepts a balanced journal', () => {
    const r = validatePosting(req([['sales', '0', '100'], ['rent', '100', '0']]), policy());
    expect(r.ok).toBe(true);
  });
  it('refuses unbalanced, one-sided and negative lines', () => {
    expect(codes(validatePosting(req([['sales', '0', '100'], ['rent', '90', '0']]), policy()))).toContain('NOT_BALANCED');
    expect(codes(validatePosting(req([['sales', '5', '5'], ['rent', '0', '0']]), policy()))).toEqual(['ONE_SIDE_ONLY', 'ONE_SIDE_ONLY']);
    expect(codes(validatePosting(req([['sales', '-5', '0'], ['rent', '0', '-5']]), policy()))).toContain('AMOUNT_NEGATIVE');
    expect(codes(validatePosting(req([['sales', '0', '100']]), policy()))).toContain('TOO_FEW_LINES');
  });
  it('refuses closed and locked periods, soft-closed unless permitted', () => {
    const lines: [string, string, string][] = [['sales', '0', '10'], ['rent', '10', '0']];
    const p = (status: 'closed' | 'locked' | 'soft_closed') =>
      policy({ period: { id: 'p', status, startsOn: '2026-10-01', endsOn: '2026-10-31' } });
    expect(codes(validatePosting(req(lines), p('closed')))).toContain('PERIOD_CLOSED');
    expect(codes(validatePosting(req(lines), p('locked')))).toContain('PERIOD_CLOSED');
    expect(codes(validatePosting(req(lines), p('soft_closed')))).toContain('PERIOD_SOFT_CLOSED');
    expect(validatePosting(req(lines), { ...p('soft_closed'), canPostSoftClosed: true }).ok).toBe(true);
    expect(codes(validatePosting(req(lines), policy({ period: null })))).toContain('NO_PERIOD');
  });
  it('enforces the posting window', () => {
    const lines: [string, string, string][] = [['sales', '0', '10'], ['rent', '10', '0']];
    expect(codes(validatePosting(req(lines), policy({ window: { from: '2026-10-13', to: null } })))).toContain('OUTSIDE_POSTING_WINDOW');
    expect(validatePosting(req(lines), policy({ window: { from: '2026-10-01', to: '2026-10-31' } })).ok).toBe(true);
  });
  it('guards control, blocked, heading, direct-posting and currency rules', () => {
    const one = (acc: string) => codes(validatePosting(req([[acc, '10', '0'], ['sales', '0', '10']]), policy()));
    expect(one('cash')).toContain('CONTROL_ACCOUNT');
    expect(one('frozen')).toContain('ACCOUNT_BLOCKED');
    expect(one('head')).toContain('ACCOUNT_NOT_POSTING');
    expect(one('nodirect')).toContain('NO_DIRECT_POSTING');
    expect(one('usd')).toContain('ACCOUNT_CURRENCY');
    expect(one('ghost')).toContain('ACCOUNT_UNKNOWN');
    expect(one('dimreq')).toContain('DIMENSION_REQUIRED');
    // the engine itself, or a holder of the permission, may post to a control account
    expect(validatePosting(req([['cash', '10', '0'], ['sales', '0', '10']], { postedBy: 'engine' }), policy()).ok).toBe(true);
    expect(validatePosting(req([['cash', '10', '0'], ['sales', '0', '10']]), policy({ canPostControlAccounts: true })).ok).toBe(true);
  });
  it('converts to base and keeps base balanced after rounding', () => {
    const r = validatePosting(
      req([['sales', '0', '33.33'], ['rent', '16.665', '0'], ['dimno', '16.665', '0']], { currency: 'USD', rate: '129.4567', rateSource: 'manual' }),
      policy({ accounts: policy().accounts }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.posting.baseTotalDebit).toBe(r.posting.baseTotalCredit);
  });
  it('needs a rate for a foreign currency', () => {
    expect(codes(validatePosting(req([['sales', '0', '1'], ['rent', '1', '0']], { currency: 'USD', rate: '0' }), policy()))).toContain('RATE_MISSING');
  });
});

describe('periods', () => {
  it('cuts a monthly year that tiles exactly', () => {
    const p = generatePeriods('2026-01-01', 'monthly');
    expect(p).toHaveLength(12);
    expect(p[0]).toMatchObject({ startsOn: '2026-01-01', endsOn: '2026-01-31' });
    expect(p[1]!.endsOn).toBe('2026-02-28');
    expect(p[11]!.endsOn).toBe('2026-12-31');
    expect(checkPeriodsTile(p)).toEqual([]);
  });
  it('handles a July year and leap years', () => {
    const p = generatePeriods('2027-07-01', 'monthly');
    expect(p[0]!.startsOn).toBe('2027-07-01');
    expect(p[11]!.endsOn).toBe('2028-06-30');
    expect(generatePeriods('2027-03-01', 'monthly')[11]!.endsOn).toBe('2028-02-29');
  });
  it('week-based shapes also tile one year', () => {
    for (const shape of ['weeks_445', 'weeks_454', 'weeks_544', 'weeks_13x4'] as const) {
      const p = generatePeriods('2026-01-01', shape);
      expect(checkPeriodsTile(p)).toEqual([]);
      expect(p[0]!.startsOn).toBe('2026-01-01');
      expect(p[p.length - 1]!.endsOn).toBe('2026-12-31');
    }
    expect(generatePeriods('2026-01-01', 'weeks_445')).toHaveLength(12);
    expect(generatePeriods('2026-01-01', 'weeks_13x4')).toHaveLength(13);
  });
  it('date helpers clamp month ends', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
  it('allows only legal status changes', () => {
    expect(periodTransition('open', 'soft_closed')?.permission).toBe('period:soft_close');
    expect(periodTransition('soft_closed', 'closed')?.permission).toBe('period:close');
    expect(periodTransition('closed', 'open')).toMatchObject({ permission: 'period:reopen', reasonRequired: true });
    expect(periodTransition('closed', 'locked')?.reasonRequired).toBe(true);
    expect(periodTransition('locked', 'open')).toBeNull();
    expect(periodTransition('open', 'locked')).toBeNull();
  });
});

describe('chart', () => {
  it('orders numbers sensibly and matches ranges', () => {
    expect(['1000', '900', '2000'].sort(compareAccountNo)).toEqual(['900', '1000', '2000']);
    expect(matchesTotaling('1500', '1000..1999')).toBe(true);
    expect(matchesTotaling('2100', '1000..1999|2100')).toBe(true);
    expect(matchesTotaling('2000', '1000..1999')).toBe(false);
  });
  it('adds up a range of posting accounts only', () => {
    const b = [
      { no: '1110', type: 'posting' as const, net: 500n },
      { no: '1210', type: 'posting' as const, net: 300n },
      { no: '2110', type: 'posting' as const, net: -800n },
      { no: '1999', type: 'posting' as const, net: 99n },
    ];
    expect(totalBalance('1000..1998', b)).toBe(800n);
  });
  it('every shipped template is a valid chart whose setup refers to real accounts', () => {
    for (const t of CHART_TEMPLATES) {
      expect(validateChart(t.accounts), t.code).toEqual([]);
      const nos = new Set(t.accounts.map((a) => a.no));
      for (const g of t.generalSetup) {
        for (const no of [g.sales, g.salesReturns, g.salesDiscount, g.cogs, g.inventoryAdjustment]) expect(nos.has(no), `${t.code} ${no}`).toBe(true);
      }
      for (const g of t.customerGroups) {
        for (const no of [g.receivables, g.customerDeposits, g.refundsPayable, g.paymentDiscount, g.writeOff, g.rounding, g.fxGain, g.fxLoss, g.serviceCharge]) {
          expect(nos.has(no), `${t.code} ${no}`).toBe(true);
        }
      }
      // control accounts must exist for the sub-ledgers that come next
      for (const no of ['1210', '2210', '2220']) {
        expect(t.accounts.find((a) => a.no === no)?.postingSource, `${t.code} ${no}`).toBe('engine_only');
      }
    }
  });
  it('catches a broken chart', () => {
    const issues = validateChart([
      { no: '1', name: 'A', type: 'posting', category: 'assets', normalBalance: 'debit', directPosting: true, postingSource: 'manual', indent: 0 },
      { no: '1', name: 'A again', type: 'posting', category: 'assets', normalBalance: 'debit', directPosting: true, postingSource: 'manual', indent: 0 },
      { no: '9', name: 'T', type: 'total', category: null, normalBalance: 'debit', directPosting: false, postingSource: 'manual', indent: 0 },
    ]);
    expect(issues.map((i) => i.message).join(' ')).toMatch(/twice/);
    expect(issues.map((i) => i.message).join(' ')).toMatch(/needs a range/);
  });
});

describe('register hash', () => {
  const facts = {
    companyId: 'c', chainKey: 'general', seq: 1, idempotencyKey: 'k', postingDate: '2026-10-12', currency: 'KES',
    totalDebit: '10.0000', totalCredit: '10.0000', lineCount: 2, reversalOf: null,
    lines: [
      { accountId: 'a', debit: '10.0000', credit: '0.0000', dimensionSetId: null },
      { accountId: 'b', debit: '0.0000', credit: '10.0000', dimensionSetId: null },
    ],
  };
  it('is stable, and changes when anything changes', () => {
    const h = registerHash(GENESIS_HASH, facts);
    expect(h).toBe(registerHash(GENESIS_HASH, facts));
    expect(h).not.toBe(registerHash(GENESIS_HASH, { ...facts, totalDebit: '11.0000' }));
    expect(h).not.toBe(registerHash(GENESIS_HASH, { ...facts, lines: [facts.lines[1]!, facts.lines[0]!] }));
    expect(h).not.toBe(registerHash('f'.repeat(64), facts));
  });
  it('cannot be confused by moving text between fields', () => {
    expect(registerHash(GENESIS_HASH, { ...facts, chainKey: 'ab', idempotencyKey: 'c' })).not.toBe(
      registerHash(GENESIS_HASH, { ...facts, chainKey: 'a', idempotencyKey: 'bc' }),
    );
  });
});

describe('posting setup', () => {
  const rows = [
    { id: 'old', businessGroup: 'DOM', productGroup: 'GOODS', effectiveFrom: '2000-01-01', effectiveTo: '2026-06-30', accounts: { sales: 'a-old', sales_returns: null, sales_discount: null, cogs: null, inventory_adjustment: null } },
    { id: 'new', businessGroup: 'DOM', productGroup: 'GOODS', effectiveFrom: '2026-07-01', effectiveTo: null, accounts: { sales: 'a-new', sales_returns: null, sales_discount: null, cogs: null, inventory_adjustment: null } },
  ];
  it('picks the row in force on the date and records the trace', () => {
    expect(resolveGeneral(rows, 'DOM', 'GOODS', 'sales', '2026-05-01').accountId).toBe('a-old');
    const r = resolveGeneral(rows, 'DOM', 'GOODS', 'sales', '2026-10-01');
    expect(r.accountId).toBe('a-new');
    expect(r.trace.rowId).toBe('new');
  });
  it('fails loudly, naming what is missing', () => {
    expect(() => resolveGeneral(rows, 'EXP', 'GOODS', 'sales', '2026-10-01')).toThrow(SetupMissingError);
    expect(() => resolveGeneral(rows, 'DOM', 'GOODS', 'cogs', '2026-10-01')).toThrow(/no account/);
    expect(() => resolveGeneral(rows, 'DOM', 'GOODS', 'sales', '1999-01-01')).toThrow(/not in force/);
    expect(() => resolveCustomer([], 'X', 'receivables')).toThrow(/does not exist/);
  });
});
