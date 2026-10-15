/**
 * The general ledger screens: what their forms start with and send, how their rows read, and the
 * small rules behind them (a document balancing, the fiscal year in force, the account a setup
 * names). Pure: the clock and any lookups are passed in.
 */
import { ACCOUNT_CATEGORIES, ACCOUNT_TYPES, DIMENSION_RULES, NORMAL_BALANCES, isTotalType, pickOf } from './gl-options';
import type { Choice } from './payment-options';
import { has } from './values';

// ── chart of accounts ───────────────────────────────────────────────────────

export interface AccountDraft {
  id: string | null;
  no: string;
  name: string;
  type: Choice;
  category: Choice;
  normalBalance: Choice;
  directPosting: boolean;
  control: boolean;
  currencyPolicy: string;
  dimensionRule: Choice;
  totaling: string;
  indent: number;
  used: boolean;
}

export interface AccountLike {
  id: string;
  no: string;
  name: string;
  type: string;
  category: string | null;
  normalBalance: string;
  directPosting: boolean;
  postingSource: string;
  currencyPolicy: string;
  dimensionRule: string;
  totaling: string | null;
  indent: number;
  used: boolean;
}

export const blankDraft = (): AccountDraft => ({
  id: null, no: '', name: '', type: pickOf(ACCOUNT_TYPES, 'posting'), category: pickOf(ACCOUNT_CATEGORIES, 'assets'), normalBalance: pickOf(NORMAL_BALANCES, 'debit'),
  directPosting: true, control: false, currencyPolicy: 'any', dimensionRule: pickOf(DIMENSION_RULES, 'none'), totaling: '', indent: 0, used: false,
});

export const draftOf = (a: AccountLike): AccountDraft => ({
  id: a.id, no: a.no, name: a.name, type: pickOf(ACCOUNT_TYPES, a.type), category: pickOf(ACCOUNT_CATEGORIES, a.category ?? 'assets'),
  normalBalance: pickOf(NORMAL_BALANCES, a.normalBalance), directPosting: a.directPosting, control: a.postingSource === 'engine_only',
  currencyPolicy: a.currencyPolicy, dimensionRule: pickOf(DIMENSION_RULES, a.dimensionRule), totaling: a.totaling ?? '', indent: a.indent, used: a.used,
});

export function accountInput(d: AccountDraft) {
  const posting = d.type.id === 'posting';
  const currency = d.currencyPolicy.trim();
  const totaling = d.totaling.trim();
  return {
    no: d.no,
    name: d.name,
    type: d.type.id as 'posting' | 'heading' | 'begin_total' | 'end_total' | 'total',
    category: posting ? (d.category.id as 'assets' | 'liabilities' | 'equity' | 'income' | 'cost_of_sales' | 'expense') : null,
    normalBalance: d.normalBalance.id as 'debit' | 'credit',
    directPosting: posting && d.directPosting,
    postingSource: d.control ? ('engine_only' as const) : ('manual' as const),
    currencyPolicy: currency === '' ? 'any' : currency.toUpperCase(),
    dimensionRule: d.dimensionRule.id as 'none' | 'required' | 'forbidden',
    totaling: totaling === '' ? null : totaling,
    indent: d.indent,
  };
}

export const draftIsTotal = (d: AccountDraft | null): boolean => d !== null && isTotalType(d.type.id);

/** What the type column says: the category for a posting account, else the kind of heading or total. */
export const typeWords = (a: Readonly<{ type: string; category: string | null }>): string => (a.type === 'posting' ? (a.category ?? '').replaceAll('_', ' ') : a.type.replaceAll('_', '-'));

// ── fiscal calendar ─────────────────────────────────────────────────────────

export type PeriodStatus = 'open' | 'soft_closed' | 'closed' | 'locked';

export const PERIOD_STATUS: Record<PeriodStatus, { label: string; tone: 'green' | 'amber' | 'red' | 'gray' }> = {
  open: { label: 'Open', tone: 'green' },
  soft_closed: { label: 'Soft-closed', tone: 'amber' },
  closed: { label: 'Closed', tone: 'red' },
  locked: { label: 'Locked', tone: 'gray' },
};

export interface PeriodMove {
  to: PeriodStatus;
  label: string;
  reason: boolean;
}

/** The moves offered from each status (the server decides who may make them). */
export const PERIOD_MOVES: Record<PeriodStatus, readonly PeriodMove[]> = {
  open: [{ to: 'soft_closed', label: 'Soft-close', reason: false }, { to: 'closed', label: 'Close', reason: false }],
  soft_closed: [{ to: 'closed', label: 'Close', reason: false }, { to: 'open', label: 'Reopen', reason: true }],
  closed: [{ to: 'open', label: 'Reopen', reason: true }, { to: 'locked', label: 'Lock for good', reason: true }],
  locked: [],
};

/** Where the next fiscal year starts: the day after the last one ends, or January of `thisYear` when there is none. */
export function nextYearStart(lastEnd: string | null, thisYear: number): string {
  if (lastEnd === null) return `${String(thisYear)}-01-01`;
  const next = new Date(`${lastEnd}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/** The year and the dates the trial balance opens on: the year in force today, else the latest. */
export function trialBalanceRange(years: readonly { startsOn: string; endsOn: string }[], today: string): { from: string; to: string } {
  const current = years.find((y) => y.startsOn <= today && y.endsOn >= today) ?? years.at(-1);
  return { from: current?.startsOn ?? today, to: current !== undefined && current.endsOn < today ? current.endsOn : today };
}

// ── posting setup ───────────────────────────────────────────────────────────

export const GENERAL_PURPOSES: readonly (readonly [string, string])[] = [
  ['sales', 'Sales'],
  ['sales_returns', 'Sales returns'],
  ['sales_discount', 'Sales discounts'],
  ['cogs', 'Cost of sales'],
  ['inventory_adjustment', 'Inventory adjustments'],
];

export const CUSTOMER_PURPOSES: readonly (readonly [string, string])[] = [
  ['receivables', 'Receivables'],
  ['customer_deposits', 'Customer deposits (wallet)'],
  ['refunds_payable', 'Refunds payable'],
  ['payment_discount', 'Payment discounts'],
  ['write_off', 'Write-offs'],
  ['rounding', 'Rounding'],
  ['fx_gain', 'Exchange gains'],
  ['fx_loss', 'Exchange losses'],
  ['service_charge', 'Shipping and service income'],
  ['rebate_expense', 'Rebates given (cost)'],
  ['gift_card_liability', 'Gift cards (owed to holders)'],
  ['loyalty_provision', 'Loyalty points (owed)'],
];

export interface GeneralRow {
  id: string;
  businessGroupId: string;
  productGroupId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

/** The rows in force today, in business-group then product-group order. */
export function inForceToday<T extends GeneralRow>(rows: readonly T[], today: string, nameOf: (row: T) => string): T[] {
  return rows
    .filter((g) => g.effectiveFrom <= today && (g.effectiveTo === null || g.effectiveTo >= today))
    .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
}

export const accountName = (labels: Readonly<Record<string, string>>, id: string | null): string => (id !== null && Object.hasOwn(labels, id) ? labels[id] : '— not set —');

/** The accounts a setup form starts with: each purpose's account, named. */
export function startingAccounts(purposes: readonly (readonly [string, string])[], accounts: Readonly<Record<string, string | null>>, labels: Readonly<Record<string, string>>): Record<string, Choice | null> {
  return Object.fromEntries(
    purposes.map(([key]) => {
      const id = Object.hasOwn(accounts, key) ? accounts[key] : null;
      return [key, id !== null && id !== undefined ? { id, label: Object.hasOwn(labels, id) ? labels[id] : id } : null];
    }),
  );
}

export const accountIds = (chosen: Readonly<Record<string, Choice | null>>): Record<string, string | null> =>
  Object.fromEntries(Object.entries(chosen).map(([key, pick]) => [key, pick?.id ?? null]));

// ── journals ────────────────────────────────────────────────────────────────

export interface JournalLineLike {
  documentNo: string;
  debit: string;
  credit: string;
}

/** Debits and credits per document, in cents, so an out-of-balance document shows before posting. */
export function documentTotals(lines: readonly JournalLineLike[]): Map<string, { debit: number; credit: number }> {
  const out = new Map<string, { debit: number; credit: number }>();
  for (const l of lines) {
    const t = out.get(l.documentNo) ?? { debit: 0, credit: 0 };
    t.debit += Math.round(Number(l.debit) * 100);
    t.credit += Math.round(Number(l.credit) * 100);
    out.set(l.documentNo, t);
  }
  return out;
}

export const isBalanced = (totals: ReadonlyMap<string, { debit: number; credit: number }>, documentNo: string): boolean => {
  const t = totals.get(documentNo);
  return t === undefined || t.debit === t.credit;
};

export interface JournalForm {
  postingDate: string;
  documentNo: string;
  account: Choice | null;
  description: string;
  debit: string;
  credit: string;
}

export const blankLine = (postingDate: string): JournalForm => ({ postingDate, documentNo: '', account: null, description: '', debit: '', credit: '' });

const plainAmount = (v: string): string => (Number(v) === 0 ? '' : v.replace(/\.?0+$/, ''));

export const lineForm = (l: { postingDate: string; documentNo: string; accountId: string; accountNo: string; accountName: string; description: string | null; debit: string; credit: string }): JournalForm => ({
  postingDate: l.postingDate,
  documentNo: l.documentNo,
  account: { id: l.accountId, label: `${l.accountNo} ${l.accountName}` },
  description: l.description ?? '',
  debit: plainAmount(l.debit),
  credit: plainAmount(l.credit),
});

/** Typing an amount on one side clears the other. */
export const withAmount = (form: JournalForm, side: 'debit' | 'credit', value: string): JournalForm =>
  side === 'debit' ? { ...form, debit: value, credit: has(value) ? '' : form.credit } : { ...form, credit: value, debit: has(value) ? '' : form.debit };

export const lineProblem = (form: JournalForm): string | null => (form.account === null ? 'Pick an account from the list.' : null);

// ── sales posting ───────────────────────────────────────────────────────────

export const SALES_KIND: Record<string, string> = {
  invoice: 'Credit invoice',
  cash_sale: 'Cash sale',
  credit_payment: 'Payment of a credit order',
  rebate_credit: 'Rebate',
};

export const salesKind = (kind: string): string => (Object.hasOwn(SALES_KIND, kind) ? SALES_KIND[kind] : kind);

/** The mark, its colour and its words for a readiness check. */
export function checkMark(c: { ok: boolean; blocking: boolean }): { mark: string; tone: string; said: string } {
  if (c.ok) return { mark: '✓', tone: 'text-emerald-600', said: 'Done: ' };
  if (c.blocking) return { mark: '✗', tone: 'text-red-600', said: 'To do: ' };
  return { mark: '!', tone: 'text-amber-600', said: 'To do: ' };
}

// ── general ledger entries ──────────────────────────────────────────────────

export interface EntryFilter {
  account: Choice | null;
  from: string;
  to: string;
  documentNo: string;
}

export function entriesArgs(filter: EntryFilter, cursor?: { date: string; id: number }) {
  const documentNo = filter.documentNo.trim();
  return {
    ...(filter.account === null ? {} : { accountId: filter.account.id }),
    ...(filter.from === '' ? {} : { from: filter.from }),
    ...(filter.to === '' ? {} : { to: filter.to }),
    ...(documentNo === '' ? {} : { documentNo }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

// ── registers ───────────────────────────────────────────────────────────────

const originText = (origin: unknown, key: string): string => {
  if (typeof origin !== 'object' || origin === null || !Object.hasOwn(origin, key)) return '—';
  const value = (origin as Record<string, unknown>)[key];
  return typeof value === 'string' && value !== '' ? value : '—';
};

export const originSurface = (origin: unknown): string => `${originText(origin, 'surface')} → ${originText(origin, 'action')}`;
export const originPermission = (origin: unknown): string => originText(origin, 'permissionUsed');
export const originIp = (origin: unknown): string => originText(origin, 'ip');
