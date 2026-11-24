import { describe, expect, it } from 'vitest';
import { registerExecutor } from '../engine/run';
import {
  payablesAgeingExecutor,
  payablesAgeingTable,
  type PayablesAgeingResult,
} from './payables-ageing';
import {
  receivablesAgeingExecutor,
  receivablesAgeingTable,
  type AgeingByCustomer,
} from './receivables-ageing';

const ALLOWED = new Set<never>();
const ctx = (maxRows = 100, wantTable = false) => ({
  userId: 'u1',
  allowed: ALLOWED,
  now: new Date('2026-03-10T18:00:00Z'),
  maxRows,
  wantTable,
});

const LEDGER: AgeingByCustomer = {
  rows: [
    {
      id: 'c1',
      number: 'C-001',
      name: 'Wanjiku & Sons',
      owed: '1500.50',
      credits: '100.00',
      current: '500.00',
      d1_30: '400.50',
      d31_60: '300.00',
      d61_90: '200.00',
      d90_plus: '100.00',
    },
  ],
  totals: {
    owed: '1500.50',
    credits: '100.00',
    current: '500.00',
    d1_30: '400.50',
    d31_60: '300.00',
    d61_90: '200.00',
    d90_plus: '100.00',
  },
  truncated: false,
};

describe('receivables ageing executor', () => {
  it('asks the customer ledger for the company the server knows, up to the report row limit', async () => {
    const calls: [string, number][] = [];
    const ex = receivablesAgeingExecutor({
      companyId: () => Promise.resolve('co-1'),
      ledger: {
        ageingByCustomer: (companyId, limit) => {
          calls.push([companyId, limit]);
          return Promise.resolve(LEDGER);
        },
      },
    });
    const prepared = registerExecutor(ex).prepare({ companyId: 'someone-elses', limit: 5 });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const out = await prepared.run.execute(ctx(100));
    expect(calls).toEqual([['co-1', 100]]);
    expect(out.data).toEqual(LEDGER);
    expect(out.truncated).toBe(false);
    expect(out.table).toBeUndefined();
  });

  it('ignores anything the browser sends, so it cannot choose another company or a bigger list', () => {
    const ex = receivablesAgeingExecutor({
      companyId: () => Promise.resolve('co-1'),
      ledger: { ageingByCustomer: () => Promise.resolve(LEDGER) },
    });
    expect(ex.readParams({ companyId: 'x', limit: 1_000_000 })).toEqual({ ok: true, params: {} });
    expect(ex.readParams(null)).toEqual({ ok: true, params: {} });
  });

  it('passes on what the query says about a cut list', async () => {
    const ex = receivablesAgeingExecutor({
      companyId: () => Promise.resolve('co-1'),
      ledger: { ageingByCustomer: () => Promise.resolve({ ...LEDGER, truncated: true }) },
    });
    const prepared = registerExecutor(ex).prepare({});
    if (!prepared.ok) throw new Error('expected parameters to be accepted');
    expect((await prepared.run.execute(ctx())).truncated).toBe(true);
  });

  it('gives a table only when asked, with numbers as numbers and a totals row', async () => {
    const ex = receivablesAgeingExecutor({
      companyId: () => Promise.resolve('co-1'),
      ledger: { ageingByCustomer: () => Promise.resolve(LEDGER) },
    });
    const prepared = registerExecutor(ex).prepare({});
    if (!prepared.ok) throw new Error('expected parameters to be accepted');
    const out = await prepared.run.execute(ctx(100, true));
    expect(out.table).toEqual(receivablesAgeingTable(LEDGER));
    const t = receivablesAgeingTable(LEDGER);
    expect(t.columns).toHaveLength(9);
    expect(t.rows[0]).toEqual(['Wanjiku & Sons', 'C-001', 500, 400.5, 300, 200, 100, 1500.5, 100]);
    // Each row leads to the customer's account.
    expect(t.rowLinks?.[0]).toBe('/admin/finance/receivables/customer/c1');
    expect(t.totals?.[0]).toBe('Total');
    expect(t.totals?.[7]).toBe(1500.5);
    for (const row of t.rows) expect(row).toHaveLength(t.columns.length);
    expect(t.totals).toHaveLength(t.columns.length);
  });
});

const PAYABLES: PayablesAgeingResult = {
  asOf: '2026-03-10',
  basis: 'due',
  groupBy: 'vendor',
  lines: [
    {
      vendorId: 'v1',
      name: 'Otieno Hardware',
      number: 'V-001',
      currency: 'KES',
      buckets: { not_due: 100_000, d1_30: 50_050, d31_60: 0, d61_90: 0, d90_plus: 25_000 },
      owedCents: 175_050,
      unappliedCents: -5_000,
      netCents: 170_050,
    },
  ],
  totals: { not_due: 100_000, d1_30: 50_050, d31_60: 0, d61_90: 0, d90_plus: 25_000 },
  owedCents: 175_050,
  unappliedCents: -5_000,
};

describe('payables ageing executor', () => {
  const make = () => {
    const calls: { company: string; asOf: string; basis: string; groupBy: string }[] = [];
    const ex = payablesAgeingExecutor({
      companyId: () => Promise.resolve('co-1'),
      today: () => '2026-03-10',
      payables: {
        ageing: (company, asOf, opts) => {
          calls.push({ company, asOf, ...opts });
          return Promise.resolve(PAYABLES);
        },
      },
    });
    return { ex, calls };
  };

  it('defaults to today, the due date and grouping by vendor', () => {
    const { ex } = make();
    expect(ex.readParams({})).toEqual({
      ok: true,
      params: { asOf: '2026-03-10', basis: 'due', groupBy: 'vendor' },
    });
  });

  it('reads a real day and the allowed words', () => {
    const { ex } = make();
    expect(ex.readParams({ asOf: '2026-02-28', basis: 'invoice', groupBy: 'category' })).toEqual({
      ok: true,
      params: { asOf: '2026-02-28', basis: 'invoice', groupBy: 'category' },
    });
    expect(ex.readParams({ groupBy: 'posting_group' })).toMatchObject({
      params: { groupBy: 'posting_group' },
    });
  });

  it('falls back instead of passing on a day that does not exist or a word that is not allowed', () => {
    const { ex } = make();
    expect(ex.readParams({ asOf: '2026-02-30', basis: 'drop table', groupBy: ['vendor'] })).toEqual(
      {
        ok: true,
        params: { asOf: '2026-03-10', basis: 'due', groupBy: 'vendor' },
      },
    );
    expect(ex.readParams({ asOf: "2026-03-10'; --" })).toMatchObject({
      params: { asOf: '2026-03-10' },
    });
    expect(ex.readParams('junk')).toMatchObject({ ok: true });
  });

  it('calls the payables ageing query for the company the server knows', async () => {
    const { ex, calls } = make();
    const prepared = registerExecutor(ex).prepare({
      asOf: '2026-01-31',
      basis: 'invoice',
      groupBy: 'vendor',
      companyId: 'evil',
    });
    if (!prepared.ok) throw new Error('expected parameters to be accepted');
    await prepared.run.execute(ctx());
    expect(calls).toEqual([
      { company: 'co-1', asOf: '2026-01-31', basis: 'invoice', groupBy: 'vendor' },
    ]);
  });

  it('turns cents into money in the table and labels the grouping', async () => {
    const t = payablesAgeingTable(PAYABLES);
    expect(t.columns[0]?.label).toBe('Supplier');
    expect(t.columns).toHaveLength(11);
    expect(t.rows[0]).toEqual([
      'Otieno Hardware',
      'V-001',
      'KES',
      1000,
      500.5,
      0,
      0,
      250,
      1750.5,
      -50,
      1700.5,
    ]);
    expect(t.totals?.at(-1)).toBe(1700.5);
    expect(t.rowLinks?.[0]).toBe('/admin/vendors/payables/v1');
    const byCategory = payablesAgeingTable({ ...PAYABLES, groupBy: 'category' });
    expect(byCategory.columns[0]?.label).toBe('Category');
    // A line that is not one vendor leads nowhere.
    expect(byCategory.rowLinks?.[0]).toBeNull();
    const { ex } = make();
    const prepared = registerExecutor(ex).prepare({});
    if (!prepared.ok) throw new Error('expected parameters to be accepted');
    expect((await prepared.run.execute(ctx(100, true))).table).toEqual(t);
    expect((await prepared.run.execute(ctx(100, false))).table).toBeUndefined();
  });
});
