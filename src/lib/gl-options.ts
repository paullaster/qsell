import type { Choice } from './payment-options';

/**
 * The fixed choices on the general ledger screens, and the small rules behind them. Plain data and
 * pure functions, shared by the server (which offers the choices) and the screens (which print them).
 */
export const ACCOUNT_TYPES: readonly Choice[] = [
  { id: 'posting', label: 'Posting (holds a balance)' },
  { id: 'heading', label: 'Heading' },
  { id: 'begin_total', label: 'Begin-total' },
  { id: 'end_total', label: 'End-total (adds up a range)' },
  { id: 'total', label: 'Total (adds up a range)' },
];

export const ACCOUNT_CATEGORIES: readonly Choice[] = [
  { id: 'assets', label: 'Assets' },
  { id: 'liabilities', label: 'Liabilities' },
  { id: 'equity', label: 'Equity' },
  { id: 'income', label: 'Income' },
  { id: 'cost_of_sales', label: 'Cost of sales' },
  { id: 'expense', label: 'Expense' },
];

export const NORMAL_BALANCES: readonly Choice[] = [
  { id: 'debit', label: 'Debit' },
  { id: 'credit', label: 'Credit' },
];

export const DIMENSION_RULES: readonly Choice[] = [
  { id: 'none', label: 'Optional' },
  { id: 'required', label: 'Required' },
  { id: 'forbidden', label: 'Not allowed' },
];

export const CALENDAR_SHAPES: readonly Choice[] = [
  { id: 'monthly', label: '12 calendar months' },
  { id: 'weeks_445', label: '12 periods, 4-4-5 weeks' },
  { id: 'weeks_454', label: '12 periods, 4-5-4 weeks' },
  { id: 'weeks_544', label: '12 periods, 5-4-4 weeks' },
  { id: 'weeks_13x4', label: '13 periods of 4 weeks' },
];

export const pickOf = (list: readonly Choice[], id: string): Choice => ({ id, label: list.find((p) => p.id === id)?.label ?? id });

export const isTotalType = (type: string): boolean => type === 'total' || type === 'end_total';
