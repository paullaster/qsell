'use client';

import { useId, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import {
  cartQuantityWords,
  clampCartQuantity,
  parseCartQuantity,
  stepCartQuantity,
} from '@/lib/cart-quantity';
import type { QuantityLimits } from '@/lib/quantity-limits';

interface QuantityStepperProps {
  /** What it is a quantity of, for screen readers ("Quantity of Fish"). */
  label: string;
  value: number;
  /** Decimals the unit allows: 0 for pieces, up to 3 for goods sold by weight. */
  decimals: number;
  unitCode?: string;
  /** The most that can be bought. */
  available: number;
  /** The item's own least and most; empty means none. */
  limits?: QuantityLimits;
  onChange: (quantity: number) => void;
}

/**
 * The +/- buttons move by one piece, or by half a unit for goods sold by weight; the number in between can
 * also be typed (0.25 kg) and is made to fit the unit and the stock when the person is done.
 */
export function QuantityStepper({
  label,
  value,
  decimals,
  unitCode,
  available,
  limits,
  onChange,
}: QuantityStepperProps) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const words = { baseUnitCode: unitCode, baseUnitDecimals: decimals };
  const least = clampCartQuantity(0, decimals, available, limits);
  const most = clampCartQuantity(Number.MAX_SAFE_INTEGER, decimals, available, limits);

  const move = (direction: 1 | -1) => {
    setNote(null);
    setDraft(null);
    const next = stepCartQuantity(value, direction, decimals, available, limits);
    if (next > 0) onChange(next);
  };

  const settle = () => {
    if (draft === null) return;
    const typed = parseCartQuantity(draft);
    setDraft(null);
    if (typed === null) {
      setNote('Enter an amount above zero.');
      return;
    }
    const next = clampCartQuantity(typed, decimals, available, limits);
    if (next === 0) return;
    if (next === typed) setNote(null);
    else if (limits?.minQty != null && typed < limits.minQty) setNote(`The least you can buy is ${cartQuantityWords(limits.minQty, words)}.`);
    else if (limits?.maxQty != null && typed > limits.maxQty && limits.maxQty <= available) setNote(`The most you can buy is ${cartQuantityWords(limits.maxQty, words)}.`);
    else if (typed > available) setNote(`Only ${cartQuantityWords(available, words)} available.`);
    else
      setNote(
        `Amounts are counted to ${String(decimals)} ${decimals === 1 ? 'decimal' : 'decimals'}.`,
      );
    onChange(next);
  };

  const buttonClass =
    'flex h-10 w-10 shrink-0 cursor-pointer touch-manipulation items-center justify-center rounded-md text-fg hover:bg-hover disabled:cursor-not-allowed disabled:opacity-30';

  return (
    <div className="min-w-0">
      <div className="inline-flex items-center rounded-lg border border-line bg-surface-raised p-0.5">
        <button
          type="button"
          aria-label={`Less ${label}`}
          onClick={() => move(-1)}
          disabled={value <= least}
          className={buttonClass}
        >
          <Minus className="h-4 w-4" aria-hidden />
        </button>
        <input
          id={id}
          aria-label={label}
          inputMode={decimals > 0 ? 'decimal' : 'numeric'}
          autoComplete="off"
          value={draft ?? String(value)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={settle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              settle();
            }
          }}
          className="h-10 w-16 min-w-0 rounded-md bg-transparent text-center font-mono text-sm font-semibold text-fg-strong focus:outline-2 focus:outline-indigo-500"
        />
        <button
          type="button"
          aria-label={`More ${label}`}
          onClick={() => move(1)}
          disabled={value >= most}
          className={buttonClass}
        >
          <Plus className="h-4 w-4" aria-hidden />
        </button>
        {unitCode !== undefined && decimals > 0 ? (
          <span className="pr-2 pl-1 text-xs text-fg-muted">{unitCode}</span>
        ) : null}
      </div>
      <div role="status" aria-live="polite">
        {note === null ? null : <p className="mt-1 text-xs text-amber-700">{note}</p>}
      </div>
    </div>
  );
}
