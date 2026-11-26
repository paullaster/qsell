/**
 * Settling the day (docs/architecture/van-sales.md §5.3, §7): deciding a shortage, counting the cash and closing the till, and closing the day. Pure;
 * each says in words what is in the way.
 */
import { isRecord } from '@/lib/values';
import type { UnloadState } from './back';

const money = (n: number): number => Math.round(n * 100) / 100;

/** A shortage needs a manager above the company's limit; a limit of nothing means every shortage does. */
export const shortageNeedsApproval = (value: number, limit: number): boolean => value > Math.max(limit, 0);

/** What the company's rule does with a shortage, in words. */
export const RULE_WORDS = { charge_rep: 'Write it off and charge the rep', write_off: 'Write it off' } as const;
export type ShortageRule = keyof typeof RULE_WORDS;

/** Reads the reason a shortage is decided with: 3 to 300 characters. */
export function readDecision(raw: unknown): { ok: true; reason: string } | { ok: false; error: string } {
  const r = isRecord(raw) ? raw : {};
  const reason = typeof r.reason === 'string' ? r.reason.trim().replace(/\s+/g, ' ') : '';
  if (reason.length < 3 || reason.length > 300) return { ok: false, error: 'Say why the stock is missing, in 3 to 300 characters.' };
  return { ok: true, reason };
}

/** Why a shortage cannot be decided by this person now, or null. */
export function decideProblem(f: { dayStatus: string; decided: boolean; value: number; limit: number; mayApprove: boolean; isRep: boolean }): string | null {
  if (f.dayStatus !== 'reconciling') return 'Shortages are decided while the day is being counted.';
  if (f.decided) return 'That shortage has already been decided.';
  if (f.isRep) return 'The rep whose van it was does not decide its shortages.';
  if (shortageNeedsApproval(f.value, f.limit) && !f.mayApprove) return `This shortage is worth KES ${String(money(f.value))}, above KES ${String(money(f.limit))}: a manager decides it.`;
  return null;
}

function amountOf(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  return typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
}

/** Reads the cash the till was counted at: an amount of nothing or more, to two decimals, and a reason (needed only when the count differs). */
export function readTillCount(raw: unknown): { ok: true; counted: number; reason: string } | { ok: false; error: string } {
  const r = isRecord(raw) ? raw : {};
  const amount = amountOf(r.counted);
  if (!Number.isFinite(amount) || amount < 0) return { ok: false, error: 'Say how much cash was counted in the till.' };
  if (amount > 100_000_000) return { ok: false, error: 'That is more cash than the system keeps for one till.' };
  if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) return { ok: false, error: 'An amount has at most two decimals.' };
  return { ok: true, counted: money(amount), reason: typeof r.reason === 'string' ? r.reason.trim().slice(0, 200) : '' };
}

export type TillStatus = 'open' | 'closing' | 'closed' | null;

/** Why the till cannot be counted and closed now, or null: the day is being counted and its till is still open. */
export function tillProblem(f: { dayStatus: string; shift: TillStatus }): string | null {
  if (f.dayStatus !== 'reconciling') return 'The till is counted while the day is being counted.';
  if (f.shift === null) return 'This day has no till to close.';
  if (f.shift === 'closing') return 'The till\'s close is waiting for approval.';
  if (f.shift === 'closed') return 'The till is already closed.';
  return null;
}

/** Why the day cannot be closed yet, or null: its stock is back and counted, every shortage decided and its till closed. */
export function closeDayProblem(f: { dayStatus: string; hasVan: boolean; unload: UnloadState; productsOnVan: number; undecided: number; shift: TillStatus }): string | null {
  if (f.dayStatus !== 'reconciling') return 'Only a day that is being counted can be closed.';
  if (f.hasVan && f.unload !== 'received' && f.productsOnVan > 0) return 'The van still has stock on it. Unload it and receive it at the warehouse first.';
  if (f.undecided > 0) return `${String(f.undecided)} ${f.undecided === 1 ? 'shortage is' : 'shortages are'} still to be decided.`;
  if (f.shift === 'open') return 'The till has not been counted and closed yet.';
  if (f.shift === 'closing') return 'The till\'s close is waiting for approval.';
  return null;
}
