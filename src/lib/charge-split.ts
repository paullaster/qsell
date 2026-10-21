import { has } from '@/lib/values';

/** Splitting one bank charge over several accounts (fee, excise duty, tax). Money in whole cents. Pure. */

export interface ChargePartInput {
  glAccountId: string;
  /** What the person typed, e.g. "12.50". */
  amount: string;
  description?: string;
}

export interface ChargePart {
  glAccountId: string;
  cents: number;
  description: string;
}

type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

export const MAX_CHARGE_PARTS = 10;

const cents = (text: string): number | null => {
  const t = text.trim().replace(/,/g, '');
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
};

/**
 * The parts of a charge, checked against the amount the bank took. Each needs an account and an amount above zero, an account
 * may appear once (add the amounts), and together they must come to the line exactly. The message says what is wrong in words.
 */
export function checkChargeSplit(
  totalCents: number,
  parts: readonly ChargePartInput[],
): Checked<ChargePart[]> {
  if (parts.length === 0) return { ok: false, error: 'Add at least one part.' };
  if (parts.length > MAX_CHARGE_PARTS)
    return {
      ok: false,
      error: `A charge can be split into at most ${String(MAX_CHARGE_PARTS)} parts.`,
    };
  const seen = new Set<string>();
  const out: ChargePart[] = [];
  for (const [i, part] of parts.entries()) {
    const label = `Part ${String(i + 1)}`;
    if (!has(part.glAccountId))
      return { ok: false, error: `${label}: choose the account it belongs to.` };
    if (seen.has(part.glAccountId))
      return {
        ok: false,
        error: `${label}: that account is already used by another part. Add the amounts together.`,
      };
    seen.add(part.glAccountId);
    const c = cents(part.amount);
    if (c === null || c <= 0)
      return {
        ok: false,
        error: `${label}: the amount must be more than zero, with at most 2 decimals.`,
      };
    out.push({
      glAccountId: part.glAccountId,
      cents: c,
      description: (part.description ?? '').trim().slice(0, 200),
    });
  }
  const sum = out.reduce((n, p) => n + p.cents, 0);
  if (sum !== totalCents) {
    const diff = totalCents - sum;
    const words = (c: number) =>
      (Math.abs(c) / 100).toLocaleString('en-KE', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    return {
      ok: false,
      error:
        diff > 0
          ? `The parts come to ${words(sum)}; ${words(diff)} is still to place to make ${words(totalCents)}.`
          : `The parts come to ${words(sum)}, which is ${words(diff)} more than the ${words(totalCents)} the bank took.`,
    };
  }
  return { ok: true, value: out };
}

/** How much of the charge is not yet placed, for the running total on the form. */
export function chargeLeftCents(totalCents: number, amounts: readonly string[]): number {
  return totalCents - amounts.reduce((n, a) => n + (cents(a) ?? 0), 0);
}
