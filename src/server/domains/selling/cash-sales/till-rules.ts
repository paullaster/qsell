import type { PriceTrace } from '@/server/domains/pricing/domain/types';

/** Pure rules of the counter screen: how the till looks, the keypad, and the cash buttons. No clock, no database. */

export const TILL_MODES = ['admin', 'fullscreen'] as const;
export type TillMode = (typeof TILL_MODES)[number];
export const TILL_DEFAULT: TillMode = 'admin';

export function parseTillMode(value: unknown): TillMode | null {
  return TILL_MODES.find((m) => m === value) ?? null;
}

/** What the receipt says about discounts: nothing (only the price charged, the built-in behaviour), one total near the end, or the discount under each item. */
export const RECEIPT_DISCOUNTS = ['hidden', 'total', 'per_item'] as const;
export type ReceiptDiscount = (typeof RECEIPT_DISCOUNTS)[number];
export const RECEIPT_DISCOUNT_DEFAULT: ReceiptDiscount = 'hidden';

export function parseReceiptDiscount(value: unknown): ReceiptDiscount | null {
  return RECEIPT_DISCOUNTS.find((m) => m === value) ?? null;
}

const cents = (value: number): number => Math.round(value * 100) / 100;

/** Notes and coins a customer is likely to hand over (Kenya shillings), smallest first. */
export const NOTES = [50, 100, 200, 500, 1000, 2000, 5000] as const;

/**
 * The cash buttons shown for an amount due: the exact amount first, then the nearest rounder amounts a customer might hand over
 * (the next 50, 100, 500, 1000 … above it), each different, at most `count` after the exact one.
 */
export function quickCash(due: number, count = 4): number[] {
  if (!Number.isFinite(due) || due <= 0) return [];
  const exact = cents(due);
  const out: number[] = [exact];
  for (const note of NOTES) {
    const next = cents(Math.ceil(exact / note) * note);
    if (next > exact && !out.includes(next)) out.push(next);
    if (out.length > count) break;
  }
  return out;
}

export const KEYPAD_KEYS = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '00', '0', '.'] as const;

/** The amount on the keypad after one key: digits, one decimal point of at most two places, back (one off) and clear (empty). */
export function keypad(current: string, key: string): string {
  if (key === 'clear') return '';
  if (key === 'back') return current.slice(0, -1);
  if (key === '.') {
    if (current.includes('.')) return current;
    return current === '' ? '0.' : `${current}.`;
  }
  if (!/^\d+$/.test(key)) return current;
  const next = current === '0' ? key.replace(/^0+/, '') : `${current}${key}`;
  const [whole = '', fraction] = next.split('.');
  if (fraction !== undefined && fraction.length > 2) return current;
  if (whole.length > 9) return current;
  return next.startsWith('.') ? `0${next}` : next;
}

/** A quantity changed by one step, never below one unit or above the most a till line can hold. */
export function stepQuantity(current: number, step: 1 | -1): number {
  const next = cents(current + step);
  return Math.min(Math.max(next, 1), 99999);
}

/** What the person at the till sees as the state of the payment so far. */
export type PayState =
  | { kind: 'nothing' }
  | { kind: 'short'; left: number }
  | { kind: 'exact' }
  | { kind: 'change'; change: number };

export function payState(total: number | null, paid: number): PayState {
  if (total === null || paid <= 0) return { kind: 'nothing' };
  const left = cents(total - paid);
  if (left > 0) return { kind: 'short', left };
  if (left === 0) return { kind: 'exact' };
  return { kind: 'change', change: cents(-left) };
}

/** The line under the total: what the person at the till should say or do next. */
export function payWords(state: PayState, kes: (n: number) => string): { text: string; tone: 'idle' | 'short' | 'good' } {
  switch (state.kind) {
    case 'nothing':
      return { text: 'Choose how the customer pays', tone: 'idle' };
    case 'short':
      return { text: `Still to pay: ${kes(state.left)}`, tone: 'short' };
    case 'exact':
      return { text: 'Paid in full', tone: 'good' };
    case 'change':
      return { text: `Change to give: ${kes(state.change)}`, tone: 'good' };
  }
}

/**
 * What a line was discounted by, for the receipt: a discount typed at the counter (the price of one before it, less what was charged), or
 * what the discount rules took off (the line before the rules, less what was charged). A price typed higher or lower, with no discount
 * given, is a price change, not a discount, and shows nothing. Never negative.
 */
export function lineDiscount(quantity: number, total: number, trace: PriceTrace | null): number {
  if (trace === null) return 0;
  const before = trace.counterDiscount !== undefined ? trace.counterDiscount.before * quantity : trace.discounts?.lineTotalBefore;
  if (before === undefined) return 0;
  return Math.max(0, Math.round((before - total) * 100) / 100);
}
