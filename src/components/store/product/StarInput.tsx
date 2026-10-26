'use client';

import { useId } from 'react';
import { Star } from 'lucide-react';

/** Choose 1 to 5 stars. A radio group, so it works by keyboard (arrow keys) and is announced as one. */
export function StarInput({ value, onChange, label = 'Your rating' }: { value: number; onChange: (stars: number) => void; label?: string }) {
  const name = useId();
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1 text-sm font-medium text-fg">{label}</legend>
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map((stars) => (
          <label key={stars} className="relative flex h-11 w-11 cursor-pointer items-center justify-center rounded-lg focus-within:outline-2 focus-within:outline-indigo-500 hover:bg-hover">
            <input type="radio" name={name} value={stars} checked={value === stars} onChange={() => onChange(stars)} className="sr-only" />
            <Star className={`h-7 w-7 ${stars <= value ? 'fill-amber-400 text-amber-500' : 'text-fg-faint'}`} aria-hidden="true" />
            <span className="sr-only">{stars} {stars === 1 ? 'star' : 'stars'}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
