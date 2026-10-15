import { describe, expect, it } from 'vitest';
import { accountIds, accountInput, accountName, blankDraft, blankLine, checkMark, documentTotals, draftIsTotal, draftOf, entriesArgs, inForceToday, isBalanced, lineForm, lineProblem, nextYearStart, originIp, originPermission, originSurface, PERIOD_MOVES, salesKind, startingAccounts, trialBalanceRange, typeWords, withAmount } from './ledger-forms';
import { pickOf, ACCOUNT_TYPES } from './gl-options';

describe('chart of accounts form', () => {
  it('starts as a posting asset account and sends the type’s own fields only', () => {
    const d = blankDraft();
    expect(accountInput({ ...d, no: '1000', name: 'Cash', currencyPolicy: ' usd ' })).toMatchObject({ type: 'posting', category: 'assets', directPosting: true, currencyPolicy: 'USD', totaling: null, postingSource: 'manual' });
    const total = { ...d, type: pickOf(ACCOUNT_TYPES, 'total'), totaling: ' 1000..1999 ', currencyPolicy: '' };
    expect(accountInput(total)).toMatchObject({ type: 'total', category: null, directPosting: false, currencyPolicy: 'any', totaling: '1000..1999' });
    expect(draftIsTotal(total)).toBe(true);
    expect(draftIsTotal(d)).toBe(false);
    expect(draftIsTotal(null)).toBe(false);
  });

  it('opens an existing account with its words and control flag', () => {
    const d = draftOf({ id: 'a', no: '1120', name: 'Cash', type: 'posting', category: 'assets', normalBalance: 'debit', directPosting: false, postingSource: 'engine_only', currencyPolicy: 'any', dimensionRule: 'required', totaling: null, indent: 1, used: true });
    expect(d).toMatchObject({ id: 'a', control: true, used: true, dimensionRule: { id: 'required', label: 'Required' }, category: { label: 'Assets' } });
    expect(typeWords({ type: 'posting', category: 'cost_of_sales' })).toBe('cost of sales');
    expect(typeWords({ type: 'end_total', category: null })).toBe('end-total');
  });
});

describe('fiscal calendar', () => {
  it('offers the right moves from each status', () => {
    expect(PERIOD_MOVES.open.map((m) => m.to)).toEqual(['soft_closed', 'closed']);
    expect(PERIOD_MOVES.closed.filter((m) => m.reason).map((m) => m.to)).toEqual(['open', 'locked']);
    expect(PERIOD_MOVES.locked).toEqual([]);
  });

  it('starts the next year the day after the last ends, and picks the year in force for the trial balance', () => {
    expect(nextYearStart('2026-12-31', 2026)).toBe('2027-01-01');
    expect(nextYearStart('2026-06-30', 2026)).toBe('2026-07-01');
    expect(nextYearStart(null, 2026)).toBe('2026-01-01');
    const years = [{ startsOn: '2025-01-01', endsOn: '2025-12-31' }, { startsOn: '2026-01-01', endsOn: '2026-12-31' }];
    expect(trialBalanceRange(years, '2026-10-15')).toEqual({ from: '2026-01-01', to: '2026-10-15' });
    expect(trialBalanceRange(years, '2027-03-01')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(trialBalanceRange([], '2026-10-15')).toEqual({ from: '2026-10-15', to: '2026-10-15' });
  });
});

describe('posting setup', () => {
  const rows = [
    { id: '1', businessGroupId: 'b', productGroupId: 'p2', effectiveFrom: '2026-01-01', effectiveTo: null },
    { id: '2', businessGroupId: 'b', productGroupId: 'p1', effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30' },
    { id: '3', businessGroupId: 'b', productGroupId: 'p1', effectiveFrom: '2026-07-01', effectiveTo: null },
    { id: '4', businessGroupId: 'b', productGroupId: 'p3', effectiveFrom: '2027-01-01', effectiveTo: null },
  ];
  it('keeps the rows in force today, sorted by name', () => {
    expect(inForceToday(rows, '2026-10-15', (r) => r.productGroupId).map((r) => r.id)).toEqual(['3', '1']);
  });

  it('names the accounts a setup uses, and sends ids back', () => {
    const labels = { a1: '4000 Sales' };
    expect(accountName(labels, 'a1')).toBe('4000 Sales');
    expect(accountName(labels, null)).toBe('— not set —');
    expect(accountName(labels, 'zzz')).toBe('— not set —');
    const start = startingAccounts([['sales', 'Sales'], ['cogs', 'Cost']], { sales: 'a1', cogs: null }, labels);
    expect(start).toEqual({ sales: { id: 'a1', label: '4000 Sales' }, cogs: null });
    expect(accountIds(start)).toEqual({ sales: 'a1', cogs: null });
  });
});

describe('journals', () => {
  const lines = [
    { documentNo: 'J1', debit: '100.10', credit: '0' },
    { documentNo: 'J1', debit: '0', credit: '100.10' },
    { documentNo: 'J2', debit: '5', credit: '0' },
  ];
  it('shows which documents balance, to the cent', () => {
    const t = documentTotals(lines);
    expect(isBalanced(t, 'J1')).toBe(true);
    expect(isBalanced(t, 'J2')).toBe(false);
    expect(isBalanced(t, 'none')).toBe(true);
  });

  it('turns a line into a form and back, and clears the other side when an amount is typed', () => {
    const f = lineForm({ postingDate: '2026-10-01', documentNo: 'J1', accountId: 'a', accountNo: '1000', accountName: 'Cash', description: null, debit: '100.5000', credit: '0.0000' });
    expect(f).toMatchObject({ account: { id: 'a', label: '1000 Cash' }, debit: '100.5', credit: '', description: '' });
    expect(withAmount({ ...f, credit: '7' }, 'debit', '3')).toMatchObject({ debit: '3', credit: '' });
    expect(withAmount({ ...f, credit: '7' }, 'debit', '')).toMatchObject({ debit: '', credit: '7' });
    expect(lineProblem(blankLine('2026-10-01'))).toBe('Pick an account from the list.');
    expect(lineProblem(f)).toBeNull();
  });
});

describe('sales posting, entries and registers', () => {
  it('words a readiness check and a kind of sale', () => {
    expect(checkMark({ ok: true, blocking: false }).mark).toBe('✓');
    expect(checkMark({ ok: false, blocking: true })).toMatchObject({ mark: '✗', said: 'To do: ' });
    expect(checkMark({ ok: false, blocking: false }).mark).toBe('!');
    expect(salesKind('cash_sale')).toBe('Cash sale');
    expect(salesKind('odd')).toBe('odd');
  });

  it('sends only the entry filters that were set', () => {
    expect(entriesArgs({ account: null, from: '', to: '', documentNo: ' ' })).toEqual({});
    expect(entriesArgs({ account: { id: 'a', label: 'x' }, from: '2026-01-01', to: '', documentNo: ' J1 ' }, { date: 'd', id: 3 })).toEqual({ accountId: 'a', from: '2026-01-01', documentNo: 'J1', cursor: { date: 'd', id: 3 } });
  });

  it('reads a posting’s origin safely', () => {
    const origin = { surface: 'finance/receipts', action: 'post', permissionUsed: 'receipts:post' };
    expect(originSurface(origin)).toBe('finance/receipts → post');
    expect(originPermission(origin)).toBe('receipts:post');
    expect(originIp(origin)).toBe('—');
    expect(originSurface(null)).toBe('— → —');
    expect(originIp('text')).toBe('—');
  });
});
