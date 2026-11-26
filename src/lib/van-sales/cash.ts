/**
 * The cash on a van and the cash drops that keep it under its limit (docs/architecture/van-sales.md §7). Pure.
 */
import { isRecord } from '@/lib/values';

export const DROP_DESTINATIONS = ['safe', 'bank_run', 'office'] as const;
export type DropDestination = (typeof DROP_DESTINATIONS)[number];
export const DROP_DESTINATION_WORDS: Record<DropDestination, string> = { safe: 'The safe', bank_run: 'A bank run', office: 'The office' };

const money = (n: number): number => Math.round(n * 100) / 100;

function amountOf(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  return typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
}

export interface CashDropInput {
  amount: number;
  destination: DropDestination;
  note: string | null;
}

/** Reads a cash drop as typed: an amount above nothing to two decimals, where it goes, and an optional note. */
export function readCashDrop(raw: unknown): { ok: true; drop: CashDropInput } | { ok: false; error: string } {
  const r = isRecord(raw) ? raw : {};
  const amount = amountOf(r.amount);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'Say how much cash is being taken off the van.' };
  if (amount > 100_000_000) return { ok: false, error: 'That is more cash than the system keeps for one drop.' };
  if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) return { ok: false, error: 'An amount has at most two decimals.' };
  const destination = DROP_DESTINATIONS.find((d) => d === r.destination);
  if (destination === undefined) return { ok: false, error: 'Say where the cash is going: the safe, a bank run or the office.' };
  const note = typeof r.note === 'string' ? r.note.trim().replace(/\s+/g, ' ') : '';
  if (note.length > 200) return { ok: false, error: 'Keep the note to 200 characters.' };
  return { ok: true, drop: { amount: money(amount), destination, note: note === '' ? null : note } };
}

export type CashState = 'ok' | 'near' | 'over' | 'no_limit';

/** Where the cash on the van stands against its limit: near from nine tenths of it, over once it passes. */
export function cashState(cash: number, limit: number | null): CashState {
  if (limit === null || limit <= 0) return 'no_limit';
  if (cash > limit) return 'over';
  return cash >= limit * 0.9 ? 'near' : 'ok';
}

/** What to tell the rep about the cash on the van, or null when there is nothing to say. */
export function cashWords(cash: number, limit: number | null): string | null {
  const state = cashState(cash, limit);
  if (state === 'over') return `The van holds more cash than its limit. Take ${String(money(cash - (limit ?? 0)))} or more off it with a cash drop.`;
  if (state === 'near') return `The van is close to its cash limit. Make a cash drop soon.`;
  return null;
}

/** Why a cash drop cannot be made now, or null: the day is out or coming back, and it has a till open. */
export function cashDropProblem(f: { dayStatus: string; hasShift: boolean; cash: number; amount: number }): string | null {
  if (f.dayStatus !== 'out' && f.dayStatus !== 'returning') return 'Cash is taken off the van while the day is out on the route.';
  if (!f.hasShift) return 'The van has no till open, so there is no cash to take off it.';
  if (f.amount > f.cash + 1e-9) return `The van holds ${String(money(f.cash))} in cash: you cannot take off more than that.`;
  return null;
}
