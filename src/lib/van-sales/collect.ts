/**
 * Collections: money a customer pays the rep at a visit against what they owe (docs/architecture/van-sales.md §7). The rules for reading one and
 * for when it can be taken. Pure.
 */
import { isRecord } from '@/lib/values';
import { isId } from './people';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const money = (n: number): number => Math.round(n * 100) / 100;

export interface CollectInput {
  visitId: string;
  methodId: string;
  amount: number;
  /** The M-Pesa code or card slip number, where the way of paying asks for one. */
  reference: string;
  /** One key for one attempt: a retry finds the receipt already made. */
  key: string;
}

function amountOf(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  return typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
}

/** Reads a collection as the rep typed it. */
export function readCollect(raw: unknown): { ok: true; collect: CollectInput } | { ok: false; error: string } {
  const r = isRecord(raw) ? raw : {};
  if (!isId(r.visitId)) return { ok: false, error: 'Choose the visit the money is collected at.' };
  if (!isId(r.methodId)) return { ok: false, error: 'Choose how the customer paid.' };
  const amount = amountOf(r.amount);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'Say how much the customer paid.' };
  if (amount > 100_000_000) return { ok: false, error: 'That is more than the system takes in one payment.' };
  if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) return { ok: false, error: 'An amount has at most two decimals.' };
  if (typeof r.key !== 'string' || !UUID.test(r.key)) return { ok: false, error: 'This payment could not be told apart from another. Start it again.' };
  const reference = typeof r.reference === 'string' ? r.reference.trim().slice(0, 80) : '';
  return { ok: true, collect: { visitId: r.visitId, methodId: r.methodId, amount: money(amount), reference, key: r.key } };
}

/** Why money cannot be collected now, or null: the customer owes something, and no more than that is taken. */
export function collectProblem(f: { dayStatus: string; visitStatus: string; customerName: string; owed: number; amount: number }): string | null {
  if (f.dayStatus !== 'out') return 'Money is collected while the day is out on the route.';
  if (f.visitStatus !== 'arrived') return `Arrive at ${f.customerName} before collecting from them.`;
  if (f.owed <= 0) return `${f.customerName} owes nothing, so there is nothing to collect.`;
  if (f.amount > f.owed + 1e-9) return `${f.customerName} owes ${String(money(f.owed))}: you cannot collect more than that.`;
  return null;
}

/** Whether the way of paying puts cash into the van's till (cash does; M-Pesa and card go to the company's account). */
export const goesIntoTill = (kind: string): boolean => kind === 'cash';
