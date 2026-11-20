'use client';

import { useId, useState } from 'react';
import { Field, attempt, buttonClass, fieldClass } from '@/components/ui/screen-kit';
import type { GeoPoint } from '@/lib/geo';

export interface FoundPlace {
  id: string;
  label: string;
  secondary: string | null;
  point: GeoPoint;
}

/**
 * "Look up a place" for a screen where staff would otherwise type a latitude and a longitude. The search runs only when asked (the
 * Search button or Enter): the free map servers do not allow search as people type. It sits inside forms, so it is not a form itself, and
 * Enter here searches rather than saving the form around it. Choosing a place hands its point and name back; the person still checks the
 * numbers it fills in before saving.
 */
export function FindPlace({ search, onPick }: { search: (q: string) => Promise<{ ok: true; data: FoundPlace[] } | { ok: false; error: string }>; onPick: (place: FoundPlace) => void }) {
  const uid = useId();
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<FoundPlace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    setChosen(null);
    const r = await attempt(search(q));
    setBusy(false);
    if (!r.ok) {
      setFound(null);
      setError(r.error);
      return;
    }
    setFound(r.data);
  };

  return (
    <div className="space-y-2 sm:col-span-3">
      <Field id={`${uid}-q`} label="Look up a place" hint="Type its name, for example “Westlands, Nairobi”. Choose a place below to fill the latitude and longitude; check them before you save.">
        <div className="flex flex-wrap gap-2">
          <input
            id={`${uid}-q`}
            value={q}
            maxLength={120}
            autoComplete="off"
            className={`${fieldClass} min-w-0 flex-1`}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (!busy) void run();
              }
            }}
          />
          <button type="button" className={buttonClass} disabled={busy} onClick={() => void run()}>
            {busy ? 'Searching…' : 'Search'}
          </button>
        </div>
      </Field>
      {error === null ? null : (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}
      {found !== null && found.length === 0 ? (
        <p role="status" className="text-sm text-fg-muted">
          No place was found for that. Try the town or the estate, or type the latitude and longitude.
        </p>
      ) : null}
      {found !== null && found.length > 0 ? (
        <ul aria-label="Places found" className="space-y-1">
          {found.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="min-h-10 w-full cursor-pointer rounded-lg border border-line px-3 py-1.5 text-left text-sm hover:bg-hover"
                onClick={() => {
                  onPick(p);
                  setChosen(p.id);
                }}
              >
                <span className="block break-words font-semibold text-fg-strong">{p.label}</span>
                {p.secondary === null ? null : <span className="block break-words text-xs text-fg-muted">{p.secondary}</span>}
                {chosen === p.id ? <span className="block text-xs font-semibold text-green-700 dark:text-green-300">Used: {p.point.latitude.toFixed(5)}, {p.point.longitude.toFixed(5)}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
