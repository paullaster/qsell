'use client';

import { Minus, Plus } from 'lucide-react';

/** Quantities go up and down by whole units, kept to three decimals so repeated steps do not drift. */
const STEP = 1;
const tidy = (n: number) => Math.round(n * 1000) / 1000;

/**
 * A quantity field with its own minus and plus buttons, which step by 1 (so does the Up and Down
 * arrow). Typing still takes a fraction such as 2.5. The browser's tiny spinner is hidden: it is
 * hard to hit and its step used to be 0.001.
 */
export function QuantityInput({
  value,
  onChange,
  label,
  id,
  inputRef,
  onKeyDown,
  invalid,
  describedBy,
  className = '',
}: {
  value: string | number;
  onChange: (value: string) => void;
  /** Names the field for screen readers, e.g. "Quantity of Solar Panel". */
  label: string;
  id?: string;
  inputRef?: React.Ref<HTMLInputElement>;
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  invalid?: boolean;
  describedBy?: string;
  className?: string;
}) {
  const current = Number(value);
  const now = Number.isFinite(current) ? current : 0;
  const up = () => onChange(String(tidy(now + STEP)));
  const down = () => {
    if (now - STEP > 0) onChange(String(tidy(now - STEP)));
  };
  const button =
    'inline-flex min-h-10 w-9 shrink-0 cursor-pointer items-center justify-center text-fg-muted hover:bg-hover hover:text-fg-strong focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent';
  return (
    <div
      className={`flex w-full min-w-[7.5rem] items-stretch overflow-hidden rounded-lg border bg-surface ${invalid ? 'border-red-400' : 'border-line'} ${className}`}
    >
      <button
        type="button"
        className={button}
        onClick={down}
        disabled={now - STEP <= 0}
        aria-label={`One less: ${label}`}
        tabIndex={-1}
      >
        <Minus className="h-3.5 w-3.5" aria-hidden />
      </button>
      <input
        id={id}
        ref={inputRef}
        type="number"
        inputMode="decimal"
        min="0"
        step="any"
        value={value}
        aria-label={label}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
        onFocus={(event) => event.currentTarget.select()}
        // A scroll over a focused number field would change it.
        onWheel={(event) => event.currentTarget.blur()}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            up();
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            down();
          } else {
            onKeyDown?.(event);
          }
        }}
        className="min-w-0 flex-1 [appearance:textfield] bg-transparent px-1 text-center text-sm text-fg-strong focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <button
        type="button"
        className={button}
        onClick={up}
        aria-label={`One more: ${label}`}
        tabIndex={-1}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}
