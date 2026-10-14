'use client';

import { useId } from 'react';

/**
 * A short choice shown as joined buttons (two or three options, all visible at once), for when a
 * list to search would be heavier than the choice itself. It is a radio group, so it works by
 * keyboard (arrow keys) and is announced as one.
 */
export function SegmentedChoice<V extends string>({
  label,
  value,
  options,
  onChange,
  hideLabel = false,
  disabled = false,
}: {
  label: string;
  value: V;
  options: readonly { value: V; label: string }[];
  onChange: (value: V) => void;
  hideLabel?: boolean;
  disabled?: boolean;
}) {
  const name = useId();
  return (
    <fieldset className="min-w-0" disabled={disabled}>
      <legend className={hideLabel ? 'sr-only' : 'mb-1 text-sm font-medium text-fg'}>
        {label}
      </legend>
      <div className="inline-flex overflow-hidden rounded-lg border border-line">
        {options.map((option) => (
          <label
            key={option.value}
            className={`flex min-h-9 cursor-pointer items-center px-3 text-sm font-medium focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-indigo-500 ${option.value === value ? 'bg-indigo-600 text-white' : 'bg-surface text-fg hover:bg-hover'}`}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={option.value === value}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
